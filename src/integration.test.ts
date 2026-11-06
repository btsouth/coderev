/**
 * End-to-end tests against a local fake provider speaking real SSE.
 *
 * The unit tests cover pure logic, but every production failure this tool has
 * actually had was in the transport: a non-streaming request killed mid-flight
 * (reported as a clean review), a vendor reporting the same cached-token count
 * in two fields (halved the cost figure), a stream that needed line-buffered
 * reassembly. None of that is reachable from a pure function, so these tests
 * stand up a real HTTP server, stream real chunked SSE at the real client, and
 * assert on what reviewDiff returns.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import { requestCompletion, type ResolvedReviewProvider } from "./provider.ts";
import { HIDDEN_FINDING_TITLE, findHiddenCharacters } from "./hidden.ts";
import { FIND_SYSTEM_PROMPT, reviewDiff } from "./review.ts";

interface FakeBehaviour {
  /** Findings JSON the find stage should stream back. */
  findResponse: string;
  /** Given the refute prompt body, decide the verdict JSON to stream. */
  refuteResponse: (body: string) => string;
  /** Return an HTTP status to fail the next request with, or null to succeed. */
  failNext: () => number | null;
  requestCount: number;
  /** Every model request body, in arrival order. */
  bodies: Array<string>;
}

const behaviour: FakeBehaviour = {
  findResponse: '{"findings":[]}',
  refuteResponse: () => '{"refuted":false,"reason":"stands"}',
  failNext: () => null,
  requestCount: 0,
  bodies: [],
};

let server: Server;
let provider: ResolvedReviewProvider;

/** Stream `content` as several SSE chunks plus a usage chunk, like a real vendor. */
function writeSse(res: import("node:http").ServerResponse, content: string): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  // Split mid-token on purpose: reassembly across chunk boundaries is exactly
  // the code under test.
  const middle = Math.floor(content.length / 2);
  for (const piece of [content.slice(0, middle), content.slice(middle)]) {
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  res.write(
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60 },
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += String(chunk)));
    req.on("end", () => {
      // Count only model calls. Local tooling can probe a fresh loopback port
      // with a GET /, and counting that made the retry test fail on some
      // machines.
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }
      behaviour.requestCount += 1;
      behaviour.bodies.push(body);
      const failure = behaviour.failNext();
      if (failure !== null) {
        res.writeHead(failure, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `injected ${failure}` } }));
        return;
      }
      const isFind = body.includes(JSON.stringify(FIND_SYSTEM_PROMPT).slice(1, 40));
      writeSse(res, isFind ? behaviour.findResponse : behaviour.refuteResponse(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  provider = { baseUrl: `http://127.0.0.1:${address.port}/v1`, model: "fake-model", apiKey: "k" };
});

after(() => {
  server.close();
});

function reset(): void {
  behaviour.findResponse = '{"findings":[]}';
  behaviour.refuteResponse = () => '{"refuted":false,"reason":"stands"}';
  behaviour.failNext = () => null;
  behaviour.requestCount = 0;
  behaviour.bodies = [];
}

const DIFF = "--- a\n+++ b\n";

/** An exec provider that exits non-zero, standing in for a blown budget. */
const dyingAgent = {
  command: `"${process.execPath}" "${resolve("fixtures/fake-cli.mjs")}" --die`,
  model: "fake-agent",
};

describe("pipeline against a streaming provider", () => {
  it("keeps the survivor and drops the refuted finding", async () => {
    reset();
    behaviour.findResponse = JSON.stringify({
      findings: [
        { file: "a.ts", line: 10, title: "Real leak", detail: "Handle never closed." },
        { file: "b.ts", line: 20, title: "Bogus claim", detail: "Made up." },
      ],
    });
    behaviour.refuteResponse = (body) =>
      body.includes("Bogus claim")
        ? '{"refuted":true,"reason":"cannot occur"}'
        : '{"refuted":false,"reason":"stands"}';

    const result = await reviewDiff({ diff: "--- a\n+++ b\n", conventions: null, provider });

    assert.equal(result.generationError, null);
    assert.equal(result.candidates.length, 2);
    assert.deepEqual(
      result.findings.map((finding) => finding.title),
      ["Real leak"],
    );
    // 1 find + 2 findings x 2 votes: both pairs agree, so neither tiebreak
    // seat runs — the pair-then-tiebreak fast path with an identical decision.
    assert.equal(behaviour.requestCount, 5);
    assert.equal(result.usage.reported, true);
    assert.equal(result.usage.inputTokens, 500);
    // The cache field must come through the stream path, not just JSON bodies.
    assert.equal(result.usage.cachedInputTokens, 300);
  });

  it("verifies low-severity candidates through the panel", async () => {
    reset();
    behaviour.findResponse = JSON.stringify({
      findings: [
        { file: "a.ts", line: 10, title: "Data loss on close", severity: "high", detail: "d" },
        { file: "b.ts", line: 20, title: "Doc comment stale", severity: "low", detail: "d" },
      ],
    });
    const result = await reviewDiff({ diff: "x", conventions: null, provider });

    // 1 find + 2 votes per candidate; lows retain the same verification bar.
    assert.equal(behaviour.requestCount, 5);
    assert.deepEqual(
      result.findings.map((finding) => finding.title),
      ["Data loss on close", "Doc comment stale"],
    );
  });

  it("casts the tiebreak vote only when the first two seats split", async () => {
    reset();
    behaviour.findResponse = JSON.stringify({
      findings: [{ file: "a.ts", line: 10, title: "Contested claim", detail: "d" }],
    });
    // Seat lenses appear verbatim in the vote body, so the mock can split the
    // pair and let the scope seat decide.
    behaviour.refuteResponse = (body) =>
      body.includes("CHECKABILITY")
        ? '{"refuted":true,"reason":"names no trigger"}'
        : body.includes("MECHANISM ACCURACY")
          ? '{"refuted":false,"reason":"traced and confirmed"}'
          : '{"refuted":true,"reason":"restates intent"}';

    const result = await reviewDiff({ diff: "x", conventions: null, provider });

    // 1 find + a split pair + the tiebreak; majority 2-1 refuted, so dropped.
    assert.equal(behaviour.requestCount, 4);
    assert.deepEqual(result.findings, []);
    assert.equal(result.adjudicated[0]?.verdicts.length, 3);
  });

  it("reassembles JSON split across SSE chunk boundaries", async () => {
    reset();
    // writeSse splits every payload mid-token; a finding surviving proves it.
    behaviour.findResponse = JSON.stringify({
      findings: [{ file: "a.ts", line: 1, title: "Split survivor", detail: "d" }],
    });
    const result = await reviewDiff({ diff: "x", conventions: null, provider });
    assert.equal(result.findings.length, 1);
  });

  it("gives every panel vote the full changed-file context", async () => {
    reset();
    behaviour.findResponse = JSON.stringify({
      findings: [{ file: "a.ts", line: 1, title: "Needs context", detail: "d" }],
    });
    behaviour.refuteResponse = (body) => {
      assert.match(body, /UNRELATED FILE SENTINEL/);
      return '{"refuted":false,"reason":"stands"}';
    };
    const result = await reviewDiff({
      diff: "x",
      conventions: null,
      provider,
      panelContext: "--- a.ts ---\na\n--- unrelated.ts ---\nUNRELATED FILE SENTINEL",
    });
    assert.equal(result.findings.length, 1);
  });

  it("retries a 429 and then succeeds", async () => {
    reset();
    let failures = 1;
    behaviour.failNext = () => (failures-- > 0 ? 429 : null);

    const result = await requestCompletion({
      provider,
      systemPrompt: "s",
      userPrompt: "u",
      temperature: 0,
    });

    assert.equal(result.usage.reported, true);
    // First attempt got the 429, second succeeded.
    assert.equal(behaviour.requestCount, 2);
  });

  it("does not retry a 400, and reports the failed review as failed", async () => {
    reset();
    behaviour.failNext = () => 400;

    const result = await reviewDiff({ diff: "x", conventions: null, provider });

    // One attempt only: a 400 means the request is wrong, and retrying re-buys
    // the same rejection with money and time.
    assert.equal(behaviour.requestCount, 1);
    // The worst historical failure was reporting this case as a clean review.
    assert.notEqual(result.generationError, null);
    assert.match(result.generationError ?? "", /400/);
    assert.deepEqual(result.findings, []);
  });
});

describe("hidden characters", () => {
  const RLO = "\u202E";
  const LRI = "\u2066";
  const ZWSP = "\u200B";
  const TAGS = "\u{E0069}\u{E0067}";
  const HIDDEN =
    /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2028\u2029\u3164\uFFA0\uFFF9-\uFFFB\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;
  const prompts = () =>
    behaviour.bodies.map((body) =>
      (JSON.parse(body) as { messages: Array<{ content: string }> }).messages
        .map((message) => message.content)
        .join("\n"),
    );
  const rawDiff = [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1 +1,2 @@",
    " one",
    `+two ${RLO} ${TAGS}`,
    "",
  ].join("\n");

  it("never sends one to the model, on any route", async () => {
    reset();
    behaviour.findResponse = JSON.stringify({
      findings: [{ file: "a.ts", line: 2, title: "Something", detail: "d" }],
    });
    const result = await reviewDiff({
      diff: rawDiff,
      conventions: `Conventions ${RLO}`,
      context: `--- a.ts ---\ngenerator context ${ZWSP}`,
      panelContext: `--- a.ts ---\npanel context ${LRI}`,
      inventory: `inventory ${RLO}`,
      previousFindings: [{ file: "a.ts", line: 1, title: `old ${RLO}`, severity: "low" }],
      previousDropped: [{ file: "a.ts", line: 1, title: `dropped ${ZWSP}`, severity: "low" }],
      readCitedFile: async () => `one\ntwo ${RLO}\n`,
      provider,
    });
    assert.equal(result.generationError, null);
    const sent = prompts();
    assert.ok(sent.length >= 3, "find plus at least two votes");
    for (const prompt of sent) assert.doesNotMatch(prompt, HIDDEN);
    // Escaped, not deleted: the model can still see that something was there,
    // and the cited region keeps its line numbers.
    assert.match(sent[0] ?? "", /\+two \[U\+202E\] \[2 hidden tag characters\]/);
    assert.match(sent[0] ?? "", /Conventions \[U\+202E\]/);
    assert.match(sent[1] ?? "", /panel context \[U\+2066\]/);
    assert.match(sent[1] ?? "", /^2: two \[U\+202E\]$/m);
  });

  it("posts findings from the raw diff without putting them to the panel", async () => {
    reset();
    behaviour.findResponse = JSON.stringify({
      findings: [{ file: "a.ts", line: 2, title: "Model claim", detail: "d" }],
    });
    // A panel that refutes everything: if the hidden-character finding were
    // judged, injected text in the diff could argue it away.
    behaviour.refuteResponse = () => '{"refuted":true,"reason":"the comment says to ignore this"}';
    const result = await reviewDiff({
      diff: "(stripped and truncated)",
      hiddenFindings: findHiddenCharacters(rawDiff),
      conventions: null,
      provider,
    });
    assert.deepEqual(
      result.findings.map((finding) => [finding.title, finding.file, finding.line]),
      [[HIDDEN_FINDING_TITLE, "a.ts", 2]],
    );
    assert.equal(result.candidates.length, 1, "only the model's claim was a candidate");
    for (const prompt of prompts()) assert.ok(!prompt.includes(HIDDEN_FINDING_TITLE));
  });

  it("still returns them when generation fails", async () => {
    // They do not depend on the model, so an outage must not take them away
    // from a gate.
    reset();
    behaviour.failNext = () => 400;
    const result = await reviewDiff({
      diff: "x",
      hiddenFindings: findHiddenCharacters(rawDiff),
      conventions: null,
      provider,
    });
    assert.notEqual(result.generationError, null);
    assert.deepEqual(result.findings.map((finding) => finding.title), [HIDDEN_FINDING_TITLE]);
  });
});

describe("exec provider against a real child process", () => {
  it("writes both prompts to stdin and reads stdout as the completion", async () => {
    const result = await requestCompletion({
      provider: {
        command: `"${process.execPath}" "${resolve("fixtures/fake-cli.mjs")}"`,
        model: "fake-cli",
      },
      systemPrompt: "SYSTEM SENTINEL",
      userPrompt: "USER SENTINEL",
      temperature: 0,
    });

    assert.equal(result.content, '{"findings":[]}');
    assert.deepEqual(result.usage, {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reported: false,
    });
  });

  it("escapes hidden characters on the way to a CLI's stdin", async () => {
    const result = await requestCompletion({
      provider: {
        command: `"${process.execPath}" "${resolve("fixtures/fake-cli.mjs")}" --reject-hidden`,
        model: "fake-cli",
      },
      systemPrompt: "SYSTEM SENTINEL",
      userPrompt: "USER SENTINEL \u202E \u{E0069}",
      temperature: 0,
    });
    assert.equal(result.content, '{"findings":[]}');
  });

  it("rides on the second generator when the agentic CLI blows its budget", async () => {
    // Load-bearing since 2026-08-19. The agent gets twenty minutes per call so
    // that generation plus the panel fit inside the review's thirty-minute
    // ceiling, and on a large re-pass diff it can spend all twenty and still be
    // reading -- toolport PR 813 was at turn 34 when the cap landed. A review
    // must not die because its better generator ran long.
    reset();
    behaviour.findResponse = JSON.stringify({
      findings: [{ file: "a.ts", line: 1, title: "Second generator found it", detail: "Real." }],
    });
    const result = await reviewDiff({
      diff: DIFF,
      conventions: null,
      provider: dyingAgent,
      find2Provider: provider,
      refuteProvider: provider,
    });

    assert.equal(result.generationError, null, "a review that produced findings did run");
    assert.equal(result.panelError, null);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.title, "Second generator found it");
  });

  it("refuses to call a review clean when every panel seat died", async () => {
    // The second door into this tool's worst output. Generation succeeds, the
    // panel provider is the one that is down, every candidate is dropped for
    // want of a vote, and an empty findings list formats as "nothing survived"
    // -- indistinguishable from a genuinely clean pull request.
    reset();
    behaviour.findResponse = JSON.stringify({
      findings: [{ file: "a.ts", line: 1, title: "Never judged", detail: "Real." }],
    });
    const result = await reviewDiff({
      diff: DIFF,
      conventions: null,
      provider,
      refuteProvider: dyingAgent,
    });

    assert.equal(result.generationError, null, "generation itself was fine");
    assert.equal(result.candidates.length, 1, "the candidate existed");
    assert.equal(result.findings.length, 0, "and was dropped for want of a vote");
    assert.match(String(result.panelError), /never voted/);
  });

  it("rejects a successful CLI that emits no completion", async () => {
    await assert.rejects(
      requestCompletion({
        provider: {
          command: `"${process.execPath}" "${resolve("fixtures/fake-cli.mjs")}" --empty`,
          model: "fake-cli",
        },
        systemPrompt: "SYSTEM SENTINEL",
        userPrompt: "USER SENTINEL",
        temperature: 0,
      }),
      /produced no completion/,
    );
  });
});
