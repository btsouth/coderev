/**
 * Gitea and Forgejo backend, over their REST API with plain fetch.
 *
 * Gitea Actions runs GitHub-style workflows, but the pull request lives on the
 * Gitea server, so `gh` has nothing to talk to. This mirrors the functions in
 * github.ts one for one and is selected by `giteaConfig`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GiteaConfig {
  /** API root, e.g. https://git.example.com/api/v1 */
  readonly apiUrl: string;
  /** Explicit owner/repo, or null to read it from the checkout's origin. */
  readonly repository: string | null;
  readonly token: string;
}

type Env = Readonly<Record<string, string | undefined>>;

export class GiteaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GiteaError";
  }
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Returns the Gitea settings when this run targets Gitea or Forgejo, else null.
 *
 * Explicit `CODEREV_FORGE` wins. Otherwise the Actions runners announce
 * themselves with GITEA_ACTIONS or FORGEJO_ACTIONS, and they also set the
 * GitHub-compatible GITHUB_* variables this reads the server and repo from.
 */
export function giteaConfig(env: Env = process.env): GiteaConfig | null {
  const forge = present(env.CODEREV_FORGE)?.toLowerCase();
  if (forge !== undefined && forge !== "gitea" && forge !== "forgejo" && forge !== "github") {
    throw new GiteaError(`CODEREV_FORGE must be github, gitea or forgejo, not "${forge}"`);
  }
  const onGiteaRunner = env.GITEA_ACTIONS === "true" || env.FORGEJO_ACTIONS === "true";
  if (forge === "github" || (forge === undefined && !onGiteaRunner)) return null;

  const server = present(env.CODEREV_GITEA_URL);
  const apiUrl = server
    ? `${server.replace(/\/+$/, "")}/api/v1`
    : (present(env.GITHUB_API_URL) ??
      (present(env.GITHUB_SERVER_URL)
        ? `${present(env.GITHUB_SERVER_URL)!.replace(/\/+$/, "")}/api/v1`
        : undefined));
  if (apiUrl === undefined) {
    throw new GiteaError("set CODEREV_GITEA_URL to the Gitea server, e.g. https://git.example.com");
  }
  const token = present(env.GITEA_TOKEN) ?? present(env.GH_TOKEN) ?? present(env.GITHUB_TOKEN);
  if (token === undefined) throw new GiteaError("set GITEA_TOKEN (or GH_TOKEN) for the Gitea API");
  const repository = present(env.CODEREV_REPOSITORY) ?? present(env.GITHUB_REPOSITORY) ?? null;
  return { apiUrl: apiUrl.replace(/\/+$/, ""), repository, token };
}

/** owner/repo from a git remote URL, https or ssh. */
export function repositoryFromRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const match = /[:/]([^/:]+)\/([^/:]+)$/.exec(trimmed);
  return match ? `${match[1]}/${match[2]}` : null;
}

async function resolveRepository(config: GiteaConfig, cwd?: string): Promise<string> {
  if (config.repository !== null) return config.repository;
  const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
    ...(cwd === undefined ? {} : { cwd }),
  }).catch(() => ({ stdout: "" }));
  const repository = repositoryFromRemote(stdout);
  if (repository === null) {
    throw new GiteaError("could not tell the repository; set CODEREV_REPOSITORY=owner/repo");
  }
  return repository;
}

/** A PR number or a .../pulls/<n> URL, as the number. */
export function pullRequestNumber(pr: string): number {
  const match = /^(\d+)$/.exec(pr.trim()) ?? /\/pulls?\/(\d+)(?:[/?#].*)?$/.exec(pr.trim());
  if (match === null) throw new GiteaError(`not a pull request number or URL: ${pr}`);
  return Number(match[1]);
}

async function call(
  config: GiteaConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const response = await fetch(`${config.apiUrl}${path}`, {
    method,
    headers: {
      authorization: `token ${config.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new GiteaError(`Gitea ${method} ${path} failed: HTTP ${response.status} ${detail.slice(0, 300)}`);
  }
  return response;
}

async function json(config: GiteaConfig, path: string): Promise<unknown> {
  return (await call(config, "GET", path)).json();
}

function repoPath(repository: string): string {
  const [owner, name] = repository.split("/");
  return `/repos/${encodeURIComponent(owner ?? "")}/${encodeURIComponent(name ?? "")}`;
}

export async function fetchPullRequestDiff(
  config: GiteaConfig,
  pr: string,
  cwd?: string,
): Promise<string> {
  const repo = repoPath(await resolveRepository(config, cwd));
  const response = await call(config, "GET", `${repo}/pulls/${pullRequestNumber(pr)}.diff`);
  return response.text();
}

export async function fetchPullRequestFiles(
  config: GiteaConfig,
  pr: string,
  cwd?: string,
): Promise<{ headSha: string; paths: string[] }> {
  const repo = repoPath(await resolveRepository(config, cwd));
  const number = pullRequestNumber(pr);
  const view = (await json(config, `${repo}/pulls/${number}`)) as { head?: { sha?: unknown } };
  const headSha = typeof view.head?.sha === "string" ? view.head.sha : "";

  const paths: string[] = [];
  const limit = 50;
  // Bounded: a PR past 2000 files is not getting full-file context anyway.
  for (let page = 1; page <= 40; page++) {
    const files = await json(config, `${repo}/pulls/${number}/files?page=${page}&limit=${limit}`);
    if (!Array.isArray(files)) break;
    for (const entry of files) {
      const name = (entry as { filename?: unknown }).filename;
      if (typeof name === "string") paths.push(name);
    }
    if (files.length < limit) break;
  }
  return { headSha, paths };
}

export async function fetchFileAtRef(
  config: GiteaConfig,
  path: string,
  ref: string,
  cwd?: string,
): Promise<string | null> {
  try {
    const repo = repoPath(await resolveRepository(config, cwd));
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const response = await call(config, "GET", `${repo}/raw/${encoded}?ref=${encodeURIComponent(ref)}`);
    return await response.text();
  } catch {
    return null;
  }
}

export async function createInlinePullRequestReview(
  config: GiteaConfig,
  input: {
    readonly pr: string;
    readonly comments: ReadonlyArray<{ readonly path: string; readonly line: number; readonly body: string }>;
    readonly cwd?: string;
  },
): Promise<void> {
  const repo = repoPath(await resolveRepository(config, input.cwd));
  await call(config, "POST", `${repo}/pulls/${pullRequestNumber(input.pr)}/reviews`, {
    event: "COMMENT",
    body: "",
    // new_position is the line number in the new file, the same anchor GitHub
    // calls line + side RIGHT.
    comments: input.comments.map((comment) => ({
      path: comment.path,
      new_position: comment.line,
      body: comment.body,
    })),
  });
}

interface IssueComment {
  readonly id: number;
  readonly body: string;
}

async function listComments(config: GiteaConfig, repo: string, number: number): Promise<IssueComment[]> {
  const comments = await json(config, `${repo}/issues/${number}/comments`);
  if (!Array.isArray(comments)) return [];
  return comments.flatMap((entry) => {
    const { id, body } = entry as { id?: unknown; body?: unknown };
    return typeof id === "number" && typeof body === "string" ? [{ id, body }] : [];
  });
}

export async function fetchExistingReviewComment(
  config: GiteaConfig,
  input: { readonly pr: string; readonly marker: string; readonly cwd?: string },
): Promise<string | null> {
  try {
    const repo = repoPath(await resolveRepository(config, input.cwd));
    const comments = await listComments(config, repo, pullRequestNumber(input.pr));
    return comments.find((comment) => comment.body.startsWith(input.marker))?.body.trim() ?? null;
  } catch {
    return null;
  }
}

export async function upsertPullRequestComment(
  config: GiteaConfig,
  input: { readonly pr: string; readonly marker: string; readonly body: string; readonly cwd?: string },
): Promise<"created" | "updated"> {
  const repo = repoPath(await resolveRepository(config, input.cwd));
  const number = pullRequestNumber(input.pr);
  const existing = (await listComments(config, repo, number)).find((comment) =>
    comment.body.startsWith(input.marker),
  );
  if (existing !== undefined) {
    await call(config, "PATCH", `${repo}/issues/comments/${existing.id}`, { body: input.body });
    return "updated";
  }
  await call(config, "POST", `${repo}/issues/${number}/comments`, { body: input.body });
  return "created";
}
