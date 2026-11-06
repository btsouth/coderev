import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  HIDDEN_FINDING_TITLE,
  HIDDEN_FORMAT_FINDING_TITLE,
  HIDDEN_NAME_FINDING_TITLE,
  MAX_HIDDEN_LOCATIONS,
  escapeHiddenCharacters,
  findHiddenCharacters,
  hiddenFingerprint,
} from "./hidden.ts";
import {
  MAX_DIFF_CHARACTERS,
  dedupeFindings,
  formatReviewComment,
  parseCommentableLines,
  planInlineComments,
} from "./review.ts";

// Every hidden character in this file is written as an escape, so the test
// source itself stays readable in a diff view.
const RLO = "\u202E";
const LRI = "\u2066";
const PDI = "\u2069";
const ZWSP = "\u200B";
const ZWNJ = "\u200C";
const ZWJ = "\u200D";
const RLM = "\u200F";
const BOM = "\uFEFF";
const TAG_I = "\u{E0069}";
const TAG_G = "\u{E0067}";
const VS17 = "\u{E0100}";
const HIDDEN =
  /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\u2028\u2029\u3164\uFFA0\uFFF9-\uFFFB\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFE00-\uFE0F]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/u;

/** A one-hunk diff adding `lines` to `path`, starting at new-side line `start`. */
const added = (path: string, lines: ReadonlyArray<string>, start = 1) =>
  [
    `diff --git a/${path} b/${path}`,
    "index 111..222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -${start},0 +${start},${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");

const locations = (diff: string) =>
  findHiddenCharacters(diff).map((finding) => `${finding.file}:${finding.line}`);

describe("findHiddenCharacters", () => {
  it("reports a bidi control on an added line at its new-side line", () => {
    const diff = added("src/a.ts", ["const ok = 1;", `const admin = false; // ${RLO} } if (admin) {`], 10);
    const findings = findHiddenCharacters(diff);
    assert.deepEqual(findings.map((f) => [f.file, f.line]), [["src/a.ts", 11]]);
    const [finding] = findings;
    assert.equal(finding?.title, HIDDEN_FINDING_TITLE);
    assert.equal(finding?.severity, "high");
    assert.equal(finding?.disposition, "block");
    assert.equal(finding?.confidence, "high");
    assert.match(finding?.detail ?? "", /U\+202E RIGHT-TO-LEFT OVERRIDE/);
  });

  it("reports isolates, tag characters and variation selector supplements as high", () => {
    const diff = added("a.md", [`x ${LRI}y${PDI}`, `hello${TAG_I}${TAG_G}`, `emoji${VS17}`]);
    assert.deepEqual(
      findHiddenCharacters(diff).map((f) => [f.line, f.severity, f.title]),
      [
        [1, "high", HIDDEN_FINDING_TITLE],
        [2, "high", HIDDEN_FINDING_TITLE],
        [3, "high", HIDDEN_FINDING_TITLE],
      ],
    );
  });

  it("reports a zero-width space as medium formatting, fix if quick", () => {
    const [finding] = findHiddenCharacters(added("a.ts", [`const na${ZWSP}me = 1;`]));
    assert.equal(finding?.title, HIDDEN_FORMAT_FINDING_TITLE);
    assert.equal(finding?.severity, "medium");
    assert.equal(finding?.disposition, "fix-if-quick");
    assert.match(finding?.detail ?? "", /U\+200B ZERO WIDTH SPACE/);
  });

  it("reports the deprecated format controls U+206A to U+206F", () => {
    assert.deepEqual(locations(added("a.ts", ["a\u206Ab", "c\u206Fd"])), ["a.ts:1", "a.ts:2"]);
  });

  it("never puts a tag character's payload in the finding", () => {
    // Tag characters spell ASCII: U+E0069 is a hidden "i". Naming each code
    // point would hand the hidden text to whoever reads the comment, and to
    // the model on the next pass.
    const [finding] = findHiddenCharacters(added("a.md", [`ok${TAG_I}${TAG_G}`]));
    assert.match(finding?.detail ?? "", /tag characters/);
    assert.doesNotMatch(finding?.detail ?? "", /E0069|E0067/);
  });

  it("stays quiet on ZWJ inside emoji sequences", () => {
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const heartOnFire = "❤\uFE0F\u200D\u{1F525}";
    const technologist = "\u{1F469}\u{1F3FD}\u200D\u{1F4BB}";
    assert.deepEqual(locations(added("a.md", [family, heartOnFire, technologist])), []);
  });

  it("stays quiet on ZWNJ in Persian and on joiners in Indic scripts", () => {
    const persian = `می${ZWNJ}خواهم`; // "I want"
    const devanagari = `क्${ZWJ}ष`;
    assert.deepEqual(locations(added("i18n/fa.json", [persian, devanagari])), []);
  });

  it("reports joiners between Latin letters or at a line edge", () => {
    const diff = added("a.ts", [`ign${ZWNJ}ore`, `foo${ZWJ}`, `${ZWJ}bar`]);
    assert.deepEqual(
      findHiddenCharacters(diff).map((f) => [f.line, f.severity]),
      [
        [1, "medium"],
        [2, "medium"],
        [3, "medium"],
      ],
    );
  });

  it("reports joiners in scripts that do not use them", () => {
    // Only the joining scripts get the exemption; between Greek or Han letters
    // a joiner is a channel, not spelling.
    const greek = `α${ZWJ}β${ZWNJ}γ`;
    const han = `中${ZWNJ}文`;
    assert.deepEqual(locations(added("a.md", [greek, han])), ["a.md:1", "a.md:2"]);
  });

  it("reports a run of joiners even inside Persian text", () => {
    // Runs of zero-width characters are how text is hidden in plain sight; a
    // real word needs one joiner, never two in a row.
    const persian = `می${ZWNJ}${ZWNJ}${ZWJ}خ`;
    assert.deepEqual(locations(added("a.json", [persian])), ["a.json:1"]);
  });

  it("reports direction marks everywhere, beside right-to-left text too", () => {
    // Direction marks are bidi controls like the rest, so they are flagged
    // everywhere, at medium because they cannot reorder a line by themselves.
    const hebrew = `"שלום${RLM} (hello)"`;
    const [finding] = findHiddenCharacters(added("he.json", [hebrew]));
    assert.equal(finding?.line, 1);
    assert.equal(finding?.severity, "medium");
    assert.match(finding?.detail ?? "", /U\+200F RIGHT-TO-LEFT MARK/);
    assert.deepEqual(locations(added("a.ts", [`return a${RLM} + b;`])), ["a.ts:1"]);
  });

  it("reports a run of variation selectors, the smuggling shape, and allows a single one", () => {
    // Two selectors in a row encode a byte; real text uses at most one after
    // its base character.
    const smuggled = `ok\uFE00\uFE01\uFE02\uFE0F`;
    assert.deepEqual(
      findHiddenCharacters(added("a.md", [smuggled])).map((f) => [f.line, f.severity]),
      [[1, "high"]],
    );
    const emoji = "❤\uFE0F and ☺\uFE0E";
    const ideographicVariant = "葛\u{E0100}";
    assert.deepEqual(locations(added("a.md", [emoji, ideographicVariant])), []);
  });

  it("reports single variation selectors spread over ordinary text", () => {
    // One selector per letter carries four bits and shows nothing.
    const spread = "h\uFE01e\uFE02l\uFE03l\uFE04o";
    assert.deepEqual(locations(added("a.md", [spread, "a\uFE0F", "b\uFE0E", "1\uFE0F", "x\u{E0101}"])), [
      "a.md:1",
      "a.md:2",
      "a.md:3",
      "a.md:4",
      "a.md:5",
    ]);
  });

  it("stays quiet on keycaps, math variants and Mongolian free variation selectors", () => {
    const keycap = "1\uFE0F\u20E3 #\uFE0F\u20E3";
    const flagWithSelector = "\u{1F3F3}\uFE0F\u200D\u{1F308}";
    const math = "\u2269\uFE00";
    const mongolian = "\u1820\u180B";
    assert.deepEqual(locations(added("a.md", [keycap, flagWithSelector, math, mongolian])), []);
    assert.deepEqual(locations(added("a.md", ["\u1820\u180B\u180C", "a\u180B"])), ["a.md:1", "a.md:2"]);
  });

  it("reports fillers, soft hyphens and other default-ignorable characters as medium", () => {
    // U+3164 is a valid JavaScript identifier that draws as nothing.
    const lines = ["const \u3164 = 1;", "pass\u00ADword", "a\u034Fb", "x\uFFA0y", "c\u115Fd", "e\u17B4f", "g\uFFF9h", "i\u{1D173}j"];
    const findings = findHiddenCharacters(added("a.js", lines));
    assert.deepEqual(
      findings.map((f) => [f.line, f.title, f.severity]),
      lines.map((_, i) => [i + 1, HIDDEN_FORMAT_FINDING_TITLE, "medium"]),
    );
    assert.match(findings[0]?.detail ?? "", /U\+3164 HANGUL FILLER/);
    assert.match(findings[1]?.detail ?? "", /U\+00AD SOFT HYPHEN/);
  });

  it("reports line and paragraph separators as high", () => {
    // In JavaScript U+2028 ends a line comment, so the code after it runs.
    const [finding] = findHiddenCharacters(added("a.js", ["// note\u2028evil();", "x\u2029y"]));
    assert.equal(finding?.severity, "high");
    assert.equal(finding?.title, HIDDEN_FINDING_TITLE);
    assert.match(finding?.detail ?? "", /U\+2028 LINE SEPARATOR/);
  });

  it("stays quiet on a byte order mark at the start of a file, and reports one anywhere else", () => {
    assert.deepEqual(locations(added("a.cs", [`${BOM}using System;`])), []);
    assert.deepEqual(locations(added("a.cs", [`using${BOM} System;`])), ["a.cs:1"]);
    assert.deepEqual(locations(added("a.cs", [`${BOM}using System;`], 5)), ["a.cs:5"]);
  });

  it("ignores removed and unchanged lines", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,3 @@",
      ` context ${RLO}`,
      `-removed ${RLO}`,
      "+added clean",
      "",
    ].join("\n");
    assert.deepEqual(locations(diff), []);
  });

  it("scans generated files and text past the review size limit", () => {
    // Called on the raw diff: the lockfile hunk is stripped before the model
    // sees it and the tail is truncated, and neither may hide a character.
    const lockfile = added("package-lock.json", [`"x": "1${RLO}"`]);
    const filler = added("big.txt", ["x".repeat(MAX_DIFF_CHARACTERS)]);
    const tail = added("late.ts", [`late${RLO}`]);
    assert.deepEqual(locations(lockfile + filler + tail), ["package-lock.json:1", "late.ts:1"]);
  });

  it("reports a hidden character in a changed file name", () => {
    const diff = added(`src/ok${RLO}.ts`, ["clean"]);
    const findings = findHiddenCharacters(diff);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.title, HIDDEN_NAME_FINDING_TITLE);
    assert.equal(findings[0]?.line, 0);
    assert.equal(findings[0]?.file, `src/ok${RLO}.ts`);
  });

  it("decodes git's quoted form of a file name", () => {
    // Git writes non-ASCII paths as octal UTF-8 bytes inside double quotes.
    const diff = [
      'diff --git "a/ok\\342\\200\\256.ts" "b/ok\\342\\200\\256.ts"',
      "new file mode 100644",
      "--- /dev/null",
      '+++ "b/ok\\342\\200\\256.ts"',
      "@@ -0,0 +1 @@",
      "+clean",
      "",
    ].join("\n");
    assert.deepEqual(
      findHiddenCharacters(diff).map((f) => [f.title, f.file]),
      [[HIDDEN_NAME_FINDING_TITLE, `ok${RLO}.ts`]],
    );
  });

  it("checks the names of renamed, copied and binary files, which have no +++ header", () => {
    const diff = [
      `diff --git a/old.ts b/new${RLO}.ts`,
      "similarity index 100%",
      "rename from old.ts",
      `rename to new${RLO}.ts`,
      `diff --git a/a.ts b/copy${LRI}.ts`,
      "similarity index 100%",
      "copy from a.ts",
      `copy to copy${LRI}.ts`,
      `diff --git a/logo${ZWSP}.png b/logo${ZWSP}.png`,
      "new file mode 100644",
      "index 0000000..1111111",
      `Binary files /dev/null and b/logo${ZWSP}.png differ`,
      "",
    ].join("\n");
    assert.deepEqual(
      findHiddenCharacters(diff).map((f) => [f.file, f.severity]),
      [
        [`new${RLO}.ts`, "high"],
        [`copy${LRI}.ts`, "high"],
        [`logo${ZWSP}.png`, "medium"],
      ],
    );
  });

  it("checks the names of new empty files and mode-only changes, which have no hunk", () => {
    const diff = [
      'diff --git "a/ok\\342\\200\\256.ts" "b/ok\\342\\200\\256.ts"',
      "new file mode 100644",
      "index 0000000..e69de29",
      `diff --git a/run\u2066.sh b/run\u2066.sh`,
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");
    assert.deepEqual(
      findHiddenCharacters(diff).map((f) => f.file),
      ["ok\u202E.ts", "run\u2066.sh"],
    );
  });

  it("reports a file name once when several headers name it", () => {
    const diff = added(`a\u202E.ts`, ["clean"]);
    assert.equal(findHiddenCharacters(diff).filter((f) => f.title === HIDDEN_NAME_FINDING_TITLE).length, 1);
  });

  it("keeps a byte order mark at the end of a file name", () => {
    // String.prototype.trim treats U+FEFF as whitespace and would erase the
    // very character under test.
    const diff = added("a.ts\uFEFF", ["clean"]);
    assert.deepEqual(findHiddenCharacters(diff).map((f) => f.file), ["a.ts\uFEFF"]);
  });

  it("decodes every escape git uses in a quoted name", () => {
    const diff = [
      'diff --git "a/a\\r\\t\\342\\200\\256.ts" "b/a\\r\\t\\342\\200\\256.ts"',
      '--- "a/a\\r\\t\\342\\200\\256.ts"',
      '+++ "b/a\\r\\t\\342\\200\\256.ts"',
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n");
    assert.deepEqual(findHiddenCharacters(diff).map((f) => f.file), ["a\r\t\u202E.ts"]);
  });

  it("stays quiet on ZWNJ after an Arabic vowel mark", () => {
    // Vowel marks are Script=Inherited and transparent for joining, so the
    // letter they sit on decides the context.
    const kasra = `\u0645\u06CC\u0650${ZWNJ}\u062E\u0648\u0627\u0647\u0645`;
    assert.deepEqual(locations(added("fa.json", [kasra])), []);
    assert.equal(escapeHiddenCharacters(kasra), kasra);
  });

  it("still reports ZWNJ after a mark on a Latin letter", () => {
    assert.deepEqual(locations(added("a.ts", [`e\u0301${ZWNJ}x`])), ["a.ts:1"]);
  });

  it("does not report the name of a file the pull request deletes", () => {
    const diff = [
      `diff --git a/bad\u202E.ts b/bad\u202E.ts`,
      "deleted file mode 100644",
      "index e69de29..0000000",
      `diff --git a/old\u202E.ts b/old\u202E.ts`,
      "deleted file mode 100644",
      "index 1111111..0000000",
      `--- a/old\u202E.ts`,
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "",
    ].join("\n");
    assert.deepEqual(findHiddenCharacters(diff), []);
  });

  it("returns nothing for a clean diff", () => {
    assert.deepEqual(findHiddenCharacters(added("a.ts", ["const a = 1;", "été \u{1F600}"])), []);
  });

  it("caps the listed lines and states the total", () => {
    const lines = Array.from({ length: MAX_HIDDEN_LOCATIONS + 5 }, (_, i) => `l${i}${ZWSP}`);
    const findings = findHiddenCharacters(added("a.ts", lines));
    assert.equal(findings.length, MAX_HIDDEN_LOCATIONS);
    assert.match(findings[0]?.detail ?? "", new RegExp(`${MAX_HIDDEN_LOCATIONS + 5} added lines`));
  });

  it("keeps a high finding when the cap is full of medium ones", () => {
    // A gate on high must not pass because twenty zero-width spaces came
    // first and the override on line twenty-one fell off the list.
    const lines = [
      ...Array.from({ length: MAX_HIDDEN_LOCATIONS }, (_, i) => `l${i}${ZWSP}`),
      `admin${RLO}`,
    ];
    const findings = findHiddenCharacters(added("a.ts", lines));
    assert.deepEqual(
      findings.filter((f) => f.severity === "high").map((f) => f.line),
      [MAX_HIDDEN_LOCATIONS + 1],
    );
  });

  it("groups each kind into one summary entry and one inline comment", () => {
    // Separate titles per kind, so a high override added later is fresh
    // rather than matched to an earlier medium zero-width finding.
    const diff = added("a.ts", [`a${RLO}`, "b", `c${ZWSP}`]) + added("b.ts", [`d${RLO}`]);
    const grouped = dedupeFindings(findHiddenCharacters(diff));
    assert.deepEqual(
      grouped.map((group) => [group.title, group.severity, group.locations]),
      [
        [HIDDEN_FINDING_TITLE, "high", [{ file: "a.ts", line: 1 }, { file: "b.ts", line: 1 }]],
        [HIDDEN_FORMAT_FINDING_TITLE, "medium", [{ file: "a.ts", line: 3 }]],
      ],
    );
    const { anchored } = planInlineComments(grouped, parseCommentableLines(diff));
    assert.deepEqual(anchored.map((comment) => [comment.path, comment.line]), [
      ["a.ts", 1],
      ["a.ts", 3],
    ]);
  });

  it("anchors inline on a file whose own name is hidden-character bearing", () => {
    const diff = added(`a${ZWSP}.ts`, [`x${RLO}`]);
    const lineFindings = findHiddenCharacters(diff).filter((f) => f.line > 0);
    const { anchored } = planInlineComments(dedupeFindings(lineFindings), parseCommentableLines(diff));
    assert.equal(anchored.length, 1);
    assert.equal(anchored[0]?.path, `a${ZWSP}.ts`);
    assert.doesNotMatch(anchored[0]?.body ?? "", HIDDEN);
  });
});

describe("posted comments", () => {
  it("escape hidden characters in every finding, the model's included", () => {
    const comment = formatReviewComment({
      findings: [
        { file: `a${RLO}.ts`, line: 1, title: `Model title ${RLO}`, detail: `detail ${TAG_I}`, severity: "low" },
      ],
      model: "m",
      truncated: false,
    });
    assert.doesNotMatch(comment, HIDDEN);
    assert.match(comment, /Model title \[U\+202E\]/);
  });

  it("escape inline comment bodies but keep the real path for the anchor", () => {
    const diff = added(`a${RLO}.ts`, ["x"]);
    const { anchored } = planInlineComments(
      dedupeFindings([{ file: `a${RLO}.ts`, line: 1, title: `t ${RLO}`, detail: "d", severity: "low" }]),
      parseCommentableLines(diff),
    );
    assert.equal(anchored[0]?.path, `a${RLO}.ts`);
    assert.doesNotMatch(anchored[0]?.body ?? "", HIDDEN);
  });
});

describe("across passes", () => {
  // Hidden-character findings are recomputed in full on every pass, so they
  // are matched to earlier passes by exact location, never by title alone.
  const model = { file: "a.ts", line: 9, title: "Model finding from round two", severity: "medium" as const };
  const stored = (file: string, line: number) => ({
    file,
    line,
    title: HIDDEN_FINDING_TITLE,
    severity: "high" as const,
  });

  it("shows a hidden character at a new line of an already-reported file as new", () => {
    const comment = formatReviewComment({
      findings: findHiddenCharacters(added("a.ts", [`x${RLO}`], 40)),
      model: "m",
      truncated: false,
      previous: [stored("a.ts", 9)],
      changedLines: null,
    });
    assert.match(comment, /New in this pass: 1 issue/);
    assert.match(comment, /`a\.ts`:40/);
    assert.doesNotMatch(comment, /`a\.ts`:9/);
  });

  it("splits a group into its new and its still-present locations", () => {
    const diff = added("a.ts", [`x${RLO}`]) + added("b.ts", [`y${RLO}`]);
    const comment = formatReviewComment({
      findings: findHiddenCharacters(diff),
      model: "m",
      truncated: false,
      previous: [stored("a.ts", 1), model],
      changedLines: null,
    });
    const [fresh, open] = comment.split("Still open from earlier passes:");
    assert.match(fresh ?? "", /`b\.ts`:1/);
    assert.doesNotMatch(fresh ?? "", /`a\.ts`:1/);
    assert.match(open ?? "", /`a\.ts`:1/);
    assert.match(open ?? "", /Model finding from round two/);
    assert.doesNotMatch(comment, /Resolved since/);
  });

  it("drops a hidden character the push removed instead of carrying it", () => {
    const comment = formatReviewComment({
      findings: [],
      model: "m",
      truncated: false,
      previous: [stored("a.ts", 9), model],
      changedLines: null,
    });
    assert.doesNotMatch(comment, new RegExp(HIDDEN_FINDING_TITLE));
    assert.match(comment, /Model finding from round two/);
  });

  it("keeps the disposition order when hidden findings are split from model findings", () => {
    const titles = [
      "Race between flush and close",
      "Token leaks into logs",
      "Retry loop never backs off",
      "Migration drops the index",
      "Cache key ignores locale",
    ];
    const blocks = titles.map((title, i) => ({
      file: `m${i}.ts`,
      line: 1,
      title,
      detail: `d${i}`,
      severity: "high" as const,
      disposition: "block" as const,
    }));
    const comment = formatReviewComment({
      findings: [...findHiddenCharacters(added("z.ts", [`x${ZWSP}`])), ...blocks],
      model: "m",
      truncated: false,
      previous: [model],
      changedLines: null,
    });
    const [detailed] = comment.split("Also noted:");
    for (const title of titles) assert.ok((detailed ?? "").includes(`**${title}**`), title);
    assert.ok(comment.indexOf(HIDDEN_FORMAT_FINDING_TITLE) > comment.indexOf("Cache key ignores locale"));
  });

  it("never folds a model finding into a hidden-character group", () => {
    const grouped = dedupeFindings([
      ...findHiddenCharacters(added("a.ts", [`x${RLO}`])),
      { file: "b.ts", line: 4, title: "Hidden characters", detail: "model text", severity: "medium" },
    ]);
    assert.deepEqual(
      grouped.map((group) => [group.title, group.locations.length]),
      [
        [HIDDEN_FINDING_TITLE, 1],
        ["Hidden characters", 1],
      ],
    );
  });

  it("words the detail as a statement about the whole diff, true for any subset of locations", () => {
    const [finding] = findHiddenCharacters(added("a.ts", [`x${RLO}`]) + added("b.ts", [`y${RLO}`]));
    assert.match(finding?.detail ?? "", /^In this diff, 2 added lines across 2 files contain/);
  });

  it("says when the model review was skipped and only the deterministic check ran", () => {
    const comment = formatReviewComment({
      findings: findHiddenCharacters(added("a.ts", [`x${RLO}`])),
      model: "m",
      truncated: false,
      modelReviewSkipped: "the round budget for this pull request is spent",
    });
    assert.match(comment, /model review was skipped: the round budget for this pull request is spent/);
    assert.doesNotMatch(comment, /each filtered through/);
  });

  it("notes in the footer that hidden-character findings skip the panel", () => {
    const comment = formatReviewComment({
      findings: findHiddenCharacters(added("a.ts", [`x${RLO}`])),
      model: "m",
      truncated: false,
    });
    assert.match(comment, /Hidden-character findings come from a deterministic check and skip the panel/);
  });
});

describe("hiddenFingerprint", () => {
  it("is empty without findings, so existing diff hashes do not change", () => {
    assert.equal(hiddenFingerprint([]), "");
  });

  it("changes when a hidden character is added where the reviewed diff cannot see it", () => {
    const before = hiddenFingerprint(findHiddenCharacters(added("package-lock.json", [`a${ZWSP}`])));
    const after = hiddenFingerprint(
      findHiddenCharacters(added("package-lock.json", [`a${ZWSP}`, `b${RLO}`])),
    );
    assert.notEqual(before, "");
    assert.notEqual(before, after);
  });
});

describe("escapeHiddenCharacters", () => {
  it("writes each control as a visible code point", () => {
    assert.equal(escapeHiddenCharacters(`a${RLO}b${ZWSP}c${RLM}`), "a[U+202E]b[U+200B]c[U+200F]");
  });

  it("collapses a run of tag characters without their payload", () => {
    const escaped = escapeHiddenCharacters(`ok${TAG_I}${TAG_G}${TAG_I}.`);
    assert.equal(escaped, "ok[3 hidden tag characters].");
  });

  it("collapses a run of variation selectors", () => {
    assert.equal(escapeHiddenCharacters(`x${VS17}${VS17}`), "x[2 hidden variation selectors]");
    assert.equal(escapeHiddenCharacters("x\uFE00\uFE01\uFE02"), "x[3 hidden variation selectors]");
  });

  it("keeps line numbers: no line is added or removed", () => {
    const text = [`one${RLO}`, `two${TAG_I}${TAG_G}`, "three", `four${ZWSP}\r`].join("\n");
    const escaped = escapeHiddenCharacters(text);
    assert.equal(escaped.split("\n").length, text.split("\n").length);
    assert.equal(escaped.split("\n")[2], "three");
  });

  it("leaves legitimate joiners and selectors untouched", () => {
    const text = `\u{1F468}\u200D\u{1F469} می${ZWNJ}خ ❤\uFE0F 葛\u{E0100}`;
    assert.equal(escapeHiddenCharacters(text), text);
  });

  it("leaves no hidden character behind", () => {
    const text = `${BOM}a${RLO}${LRI}b${PDI}${ZWJ}${ZWJ}c${TAG_I}${VS17}\u061C\u180E\u2060\u2064\u206A x\uFE00\uFE01`;
    assert.doesNotMatch(escapeHiddenCharacters(text), HIDDEN);
  });

  it("escapes fillers and separators so none reach the model", () => {
    assert.equal(escapeHiddenCharacters("const \u3164 = 1; // a\u2028b"), "const [U+3164] = 1; // a[U+2028]b");
    assert.equal(escapeHiddenCharacters("h\uFE01i"), "h[1 hidden variation selector]i");
  });

  it("is idempotent", () => {
    const once = escapeHiddenCharacters(`a${RLO}${TAG_I}${TAG_G}b`);
    assert.equal(escapeHiddenCharacters(once), once);
  });

  it("returns clean text unchanged", () => {
    const text = "const café = '\u{1F600}';\n";
    assert.equal(escapeHiddenCharacters(text), text);
  });
});
