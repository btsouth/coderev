import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";

import {
  createInlinePullRequestReview,
  fetchExistingReviewComment,
  fetchFileAtRef,
  fetchPullRequestDiff,
  fetchPullRequestFiles,
  giteaConfig,
  pullRequestNumber,
  repositoryFromRemote,
  upsertPullRequestComment,
  type GiteaConfig,
} from "./gitea.ts";

describe("giteaConfig", () => {
  it("stays off on GitHub", () => {
    assert.equal(giteaConfig({ GITHUB_ACTIONS: "true", GITHUB_API_URL: "https://api.github.com" }), null);
  });

  it("turns on for a Gitea Actions runner and reads its GitHub-style variables", () => {
    assert.deepEqual(
      giteaConfig({
        GITEA_ACTIONS: "true",
        GITHUB_API_URL: "http://gitea:3000/api/v1",
        GITHUB_REPOSITORY: "me/app",
        GH_TOKEN: "t",
      }),
      { apiUrl: "http://gitea:3000/api/v1", repository: "me/app", token: "t" },
    );
  });

  it("turns on for Forgejo and falls back to the server URL", () => {
    const config = giteaConfig({
      FORGEJO_ACTIONS: "true",
      GITHUB_SERVER_URL: "https://code.example/",
      GITHUB_TOKEN: "t",
    });
    assert.equal(config?.apiUrl, "https://code.example/api/v1");
    assert.equal(config?.repository, null);
  });

  it("lets CODEREV_FORGE force either way", () => {
    assert.equal(giteaConfig({ CODEREV_FORGE: "github", GITEA_ACTIONS: "true" }), null);
    assert.equal(
      giteaConfig({ CODEREV_FORGE: "gitea", CODEREV_GITEA_URL: "https://g.example", GITEA_TOKEN: "t" })
        ?.apiUrl,
      "https://g.example/api/v1",
    );
    assert.throws(() => giteaConfig({ CODEREV_FORGE: "gitlab" }), /github, gitea or forgejo/);
  });

  it("names the missing setting instead of failing later", () => {
    assert.throws(() => giteaConfig({ CODEREV_FORGE: "gitea", GITEA_TOKEN: "t" }), /CODEREV_GITEA_URL/);
    assert.throws(() => giteaConfig({ CODEREV_FORGE: "gitea", CODEREV_GITEA_URL: "https://g" }), /GITEA_TOKEN/);
  });
});

describe("Gitea parsing", () => {
  it("reads owner/repo from https and ssh remotes", () => {
    assert.equal(repositoryFromRemote("https://git.example/me/app.git\n"), "me/app");
    assert.equal(repositoryFromRemote("git@git.example:me/app.git"), "me/app");
    assert.equal(repositoryFromRemote("ssh://git@git.example:2222/me/app"), "me/app");
    assert.equal(repositoryFromRemote(""), null);
  });

  it("accepts a number or a pull request URL", () => {
    assert.equal(pullRequestNumber("12"), 12);
    assert.equal(pullRequestNumber("https://git.example/me/app/pulls/34"), 34);
    assert.equal(pullRequestNumber("https://git.example/me/app/pulls/34/files"), 34);
    assert.throws(() => pullRequestNumber("main"), /not a pull request/);
  });
});

interface Recorded {
  method: string;
  url: string;
  auth: string | undefined;
  body: string;
}

describe("Gitea API against a fake server", () => {
  let server: Server;
  let config: GiteaConfig;
  const requests: Recorded[] = [];
  let comments: Array<{ id: number; body: string }> = [];

  before(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += String(chunk)));
      req.on("end", () => {
        const url = req.url ?? "";
        requests.push({ method: req.method ?? "", url, auth: req.headers.authorization, body });
        const send = (status: number, payload: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (url === "/api/v1/repos/me/app/pulls/7.diff") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("diff --git a/x b/x\n");
        } else if (url === "/api/v1/repos/me/app/pulls/7") {
          send(200, { number: 7, head: { sha: "abc123" } });
        } else if (url.startsWith("/api/v1/repos/me/app/pulls/7/files?page=1")) {
          send(200, Array.from({ length: 50 }, (_, i) => ({ filename: `f${i}.ts` })));
        } else if (url.startsWith("/api/v1/repos/me/app/pulls/7/files?page=2")) {
          send(200, [{ filename: "last.ts" }]);
        } else if (url === "/api/v1/repos/me/app/raw/src/a%20b.ts?ref=abc123") {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end("content");
        } else if (url === "/api/v1/repos/me/app/issues/7/comments" && req.method === "GET") {
          send(200, comments);
        } else if (url === "/api/v1/repos/me/app/issues/7/comments" && req.method === "POST") {
          const created = { id: comments.length + 100, body: (JSON.parse(body) as { body: string }).body };
          comments.push(created);
          send(201, created);
        } else if (url.startsWith("/api/v1/repos/me/app/issues/comments/") && req.method === "PATCH") {
          const id = Number(url.split("/").pop());
          const target = comments.find((comment) => comment.id === id);
          if (target) target.body = (JSON.parse(body) as { body: string }).body;
          send(200, target);
        } else if (url === "/api/v1/repos/me/app/pulls/7/reviews" && req.method === "POST") {
          send(200, { id: 1 });
        } else {
          send(404, { message: "not found" });
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    config = { apiUrl: `http://127.0.0.1:${address.port}/api/v1`, repository: "me/app", token: "secret" };
  });

  after(() => {
    server.close();
  });

  it("fetches the diff with token auth", async () => {
    assert.equal(await fetchPullRequestDiff(config, "7"), "diff --git a/x b/x\n");
    assert.equal(requests.at(-1)?.auth, "token secret");
  });

  it("pages through changed files and reads the head sha", async () => {
    const files = await fetchPullRequestFiles(config, "7");
    assert.equal(files.headSha, "abc123");
    assert.equal(files.paths.length, 51);
    assert.equal(files.paths.at(-1), "last.ts");
  });

  it("fetches a file at a ref and degrades to null", async () => {
    assert.equal(await fetchFileAtRef(config, "src/a b.ts", "abc123"), "content");
    assert.equal(await fetchFileAtRef(config, "missing.ts", "abc123"), null);
  });

  it("creates the review comment once, then edits it in place", async () => {
    comments = [{ id: 1, body: "unrelated" }];
    assert.equal(await fetchExistingReviewComment(config, { pr: "7", marker: "<!-- coderev -->" }), null);
    assert.equal(
      await upsertPullRequestComment(config, { pr: "7", marker: "<!-- coderev -->", body: "<!-- coderev -->\nv1" }),
      "created",
    );
    assert.equal(
      await upsertPullRequestComment(config, { pr: "7", marker: "<!-- coderev -->", body: "<!-- coderev -->\nv2" }),
      "updated",
    );
    assert.equal(comments.length, 2);
    assert.equal(
      await fetchExistingReviewComment(config, { pr: "7", marker: "<!-- coderev -->" }),
      "<!-- coderev -->\nv2",
    );
  });

  it("posts inline comments anchored to new-file lines", async () => {
    await createInlinePullRequestReview(config, {
      pr: "7",
      comments: [{ path: "a.ts", line: 12, body: "here" }],
    });
    const sent = JSON.parse(requests.at(-1)?.body ?? "{}") as {
      event: string;
      comments: Array<{ path: string; new_position: number }>;
    };
    assert.equal(sent.event, "COMMENT");
    assert.deepEqual(sent.comments[0], { path: "a.ts", new_position: 12, body: "here" });
  });

  it("puts the API error in the message", async () => {
    await assert.rejects(fetchPullRequestDiff(config, "8"), /HTTP 404/);
  });
});
