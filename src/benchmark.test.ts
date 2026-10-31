import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  formatBenchmarkReport,
  LINE_MATCH_TOLERANCE,
  matchesBaseline,
  parseBenchmarkSuite,
  scoreCase,
  type BenchmarkCase,
} from "./benchmark.ts";
import { EMPTY_USAGE } from "./provider.ts";

const BASELINE = [{ file: "src/a.ts", line: 100 }];

describe("matchesBaseline", () => {
  it("matches an exact file and line", () => {
    assert.equal(matchesBaseline({ file: "src/a.ts", line: 100 }, BASELINE), true);
  });

  it("matches within the line tolerance", () => {
    // Reviewers anchor on the declaration, the branch, or the return; exact
    // equality would score agreement as disagreement.
    assert.equal(matchesBaseline({ file: "src/a.ts", line: 100 + LINE_MATCH_TOLERANCE }, BASELINE), true);
  });

  it("does not match beyond the tolerance", () => {
    assert.equal(
      matchesBaseline({ file: "src/a.ts", line: 100 + LINE_MATCH_TOLERANCE + 1 }, BASELINE),
      false,
    );
  });

  it("does not match a different file at the same line", () => {
    assert.equal(matchesBaseline({ file: "src/b.ts", line: 100 }, BASELINE), false);
  });

  it("matches on file alone when the finding has no line number", () => {
    // One run returned every finding at line 0; requiring proximity scored
    // seven file-level hits as zero matches.
    assert.equal(matchesBaseline({ file: "src/a.ts", line: 0 }, BASELINE), true);
    assert.equal(matchesBaseline({ file: "src/other.ts", line: 0 }, BASELINE), false);
  });

  it("normalises path separators and a leading ./", () => {
    assert.equal(matchesBaseline({ file: "src\\a.ts", line: 100 }, BASELINE), true);
    assert.equal(matchesBaseline({ file: "./src/a.ts", line: 100 }, BASELINE), true);
  });
});

describe("scoreCase", () => {
  const benchmarkCase: BenchmarkCase = { pr: 1, actedOn: true, baseline: BASELINE };

  it("splits reported findings into matched and unmatched", () => {
    const score = scoreCase({
      benchmarkCase,
      findings: [
        { file: "src/a.ts", line: 101 },
        { file: "src/zzz.ts", line: 4 },
      ],
      candidates: 5,
      usage: EMPTY_USAGE,
    });
    assert.partialDeepStrictEqual(score, {
      pr: 1,
      actedOn: true,
      baselineCount: 1,
      reported: 2,
      matched: 1,
      unmatched: 1,
      candidates: 5,
    });
  });

  it("scores an empty review as zero rather than as a failure", () => {
    // Reporting nothing is a legitimate outcome, not an error condition.
    const score = scoreCase({ benchmarkCase, findings: [], candidates: 0, usage: EMPTY_USAGE });
    assert.partialDeepStrictEqual(score, { reported: 0, matched: 0, unmatched: 0, failed: false });
  });

  it("distinguishes a review that failed from one that found nothing", () => {
    // Both produce an empty findings list. Conflating them makes an
    // infrastructure failure read as a clean result, which is the single most
    // misleading thing this tool could do.
    const clean = scoreCase({ benchmarkCase, findings: [], candidates: 0, usage: EMPTY_USAGE });
    const broken = scoreCase({
      benchmarkCase,
      findings: [],
      candidates: 0,
      usage: EMPTY_USAGE,
      failed: true,
    });
    assert.equal(clean.failed, false);
    assert.equal(broken.failed, true);
  });
});

describe("formatBenchmarkReport", () => {
  const suite = {
    repo: "r",
    baselineReviewer: "Baseline",
    capturedAt: "2026-08-05",
    cases: [],
  };
  const caseScore = (failed: boolean) =>
    scoreCase({
      benchmarkCase: { pr: 1, actedOn: true, baseline: BASELINE },
      findings: [],
      candidates: 0,
      usage: EMPTY_USAGE,
      failed,
    });

  it("warns prominently when reviews failed to run", () => {
    const report = formatBenchmarkReport(suite, [
      { model: "m", cases: [caseScore(true), caseScore(false)], usage: EMPTY_USAGE, costUsd: 1 },
    ]);
    assert.match(report, /1 of 2 reviews failed to run/);
    // Per-PR cost must divide by completed runs, not attempted ones, or a
    // failure would make the model look half price.
    assert.match(report, /\$1\.0000 per PR/);
  });

  it("says nothing about failures when there were none", () => {
    const report = formatBenchmarkReport(suite, [
      { model: "m", cases: [caseScore(false)], usage: EMPTY_USAGE, costUsd: 1 },
    ]);
    assert.doesNotMatch(report, /failed to run/);
  });
});

describe("parseBenchmarkSuite", () => {
  it("accepts the shipped fixture", async () => {
    const suite = parseBenchmarkSuite(
      JSON.parse(await readFile(new URL("../fixtures/toolport-studio.json", import.meta.url), "utf8")),
    );
    assert.equal(suite.repo, "btsouth/toolport-studio");
    assert.equal(suite.cases.length, 10);
    // Four PRs merged with no follow-up commit; that distinction is the whole
    // reason actedOn exists, so a fixture that lost it would be silently wrong.
    assert.equal(suite.cases.filter((entry) => !entry.actedOn).length, 4);
    assert.equal(suite.cases.reduce((sum, entry) => sum + entry.baseline.length, 0), 28);
  });

  it("defaults actedOn to false rather than assuming a fix landed", () => {
    const suite = parseBenchmarkSuite({ cases: [{ pr: 1, baseline: [] }] });
    assert.equal(suite.cases[0]?.actedOn, false);
  });

  it("rejects a suite with no cases array", () => {
    assert.throws(() => parseBenchmarkSuite({}), /cases must be an array/);
  });

  it("rejects a case with a non-numeric pr", () => {
    assert.throws(() => parseBenchmarkSuite({ cases: [{ pr: "1", baseline: [] }] }), /numeric pr/);
  });

  it("rejects a baseline entry with no file", () => {
    assert.throws(
      () => parseBenchmarkSuite({ cases: [{ pr: 1, baseline: [{ line: 1 }] }] }),
      /needs a file/,
    );
  });
});
