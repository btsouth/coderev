/**
 * Characters a diff view does not show, found and escaped before any model
 * call.
 *
 * A pull request author controls every byte of the diff, and a bidi control,
 * a zero-width space or a run of Unicode tag characters is invisible on
 * GitHub and Gitea while the model reads it like any other text. That makes
 * them a channel for instructions aimed at the reviewer, and the panel is no
 * defence: the skeptics read the same diff, so the injected text could argue
 * a finding away. These findings are therefore deterministic and skip the
 * panel, and every prompt is escaped on its way out (see requestCompletion),
 * so the model sees a visible marker where the character was.
 *
 * Legitimate text stays quiet: a ZWJ inside an emoji sequence, a ZWNJ or ZWJ
 * between letters of a script that joins (Arabic and Persian, Syriac, the
 * Indic scripts), one variation selector after a character that has that
 * variant (an emoji, a keycap, a Han ideograph, a math symbol, a Mongolian
 * letter), and a byte order mark at the start of a file. Bidi controls,
 * direction marks included, are reported everywhere.
 */
import type { FindingSeverity, ReviewFinding } from "./review.ts";

/** Lines listed per finding kind; the detail states the full count. */
export const MAX_HIDDEN_LOCATIONS = 20;

/**
 * One title per kind, so presentation groups each kind into one entry, and
 * so a high finding added on a later push is fresh rather than matched to an
 * earlier medium one. The titles share no words for the same reason.
 */
export const HIDDEN_FINDING_TITLE = "Hidden bidi or tag characters";
export const HIDDEN_FORMAT_FINDING_TITLE = "Invisible zero-width formatting marks";
export const HIDDEN_NAME_FINDING_TITLE = "Hidden character in a changed file name";

/**
 * Titles of findings recomputed in full on every pass. Earlier passes match
 * them by exact location rather than by title, because the whole set is known
 * each time (see classifyAgainstPrevious).
 */
export const HIDDEN_TITLES: ReadonlySet<string> = new Set([
  HIDDEN_FINDING_TITLE,
  HIDDEN_FORMAT_FINDING_TITLE,
  HIDDEN_NAME_FINDING_TITLE,
]);

const NAMES: Readonly<Record<number, string>> = {
  0x061c: "ARABIC LETTER MARK",
  0x180e: "MONGOLIAN VOWEL SEPARATOR",
  0x200b: "ZERO WIDTH SPACE",
  0x200c: "ZERO WIDTH NON-JOINER",
  0x200d: "ZERO WIDTH JOINER",
  0x200e: "LEFT-TO-RIGHT MARK",
  0x200f: "RIGHT-TO-LEFT MARK",
  0x202a: "LEFT-TO-RIGHT EMBEDDING",
  0x202b: "RIGHT-TO-LEFT EMBEDDING",
  0x202c: "POP DIRECTIONAL FORMATTING",
  0x202d: "LEFT-TO-RIGHT OVERRIDE",
  0x202e: "RIGHT-TO-LEFT OVERRIDE",
  0x2060: "WORD JOINER",
  0x2061: "FUNCTION APPLICATION",
  0x2062: "INVISIBLE TIMES",
  0x2063: "INVISIBLE SEPARATOR",
  0x2064: "INVISIBLE PLUS",
  0x2066: "LEFT-TO-RIGHT ISOLATE",
  0x2067: "RIGHT-TO-LEFT ISOLATE",
  0x2068: "FIRST STRONG ISOLATE",
  0x2069: "POP DIRECTIONAL ISOLATE",
  0x206a: "INHIBIT SYMMETRIC SWAPPING",
  0x206b: "ACTIVATE SYMMETRIC SWAPPING",
  0x206c: "INHIBIT ARABIC FORM SHAPING",
  0x206d: "ACTIVATE ARABIC FORM SHAPING",
  0x206e: "NATIONAL DIGIT SHAPES",
  0x206f: "NOMINAL DIGIT SHAPES",
  0xfeff: "ZERO WIDTH NO-BREAK SPACE",
  0x00ad: "SOFT HYPHEN",
  0x034f: "COMBINING GRAPHEME JOINER",
  0x115f: "HANGUL CHOSEONG FILLER",
  0x1160: "HANGUL JUNGSEONG FILLER",
  0x17b4: "KHMER VOWEL INHERENT AQ",
  0x17b5: "KHMER VOWEL INHERENT AA",
  0x180b: "MONGOLIAN FREE VARIATION SELECTOR ONE",
  0x180c: "MONGOLIAN FREE VARIATION SELECTOR TWO",
  0x180d: "MONGOLIAN FREE VARIATION SELECTOR THREE",
  0x180f: "MONGOLIAN FREE VARIATION SELECTOR FOUR",
  0x2028: "LINE SEPARATOR",
  0x2029: "PARAGRAPH SEPARATOR",
  0x3164: "HANGUL FILLER",
  0xffa0: "HALFWIDTH HANGUL FILLER",
  0xfff9: "INTERLINEAR ANNOTATION ANCHOR",
  0xfffa: "INTERLINEAR ANNOTATION SEPARATOR",
  0xfffb: "INTERLINEAR ANNOTATION TERMINATOR",
};

// Default_Ignorable_Code_Point is every character a renderer may draw as
// nothing: the bidi and zero-width controls, tag characters, variation
// selectors, and fillers such as U+3164 that JavaScript accepts in an
// identifier. Line and paragraph separators draw as nothing in a diff view
// too, and U+2028 ends a JavaScript comment, so the code after it runs.
const HIDDEN = /^[\p{Default_Ignorable_Code_Point}\u2028\u2029\uFFF9-\uFFFB]$/u;
const SELECTOR = /^[\uFE00-\uFE0F\u{E0100}-\u{E01EF}]$/u;
const EMOJI_BEFORE_JOINER = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F]$/u;
const EMOJI = /^\p{Extended_Pictographic}$/u;
const LETTER = /^[\p{L}\p{M}]$/u;
const MARK = /^\p{M}$/u;
const JOINING_SCRIPT =
  /^[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Nko}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Oriya}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Malayalam}\p{Script=Sinhala}]$/u;
const HAN = /^\p{Script=Han}$/u;
const MATH = /^\p{Sm}$/u;
const MONGOLIAN = /^\p{Script=Mongolian}$/u;
const EMOJI_BASE = /^\p{Emoji}$/u;
const KEYCAP_BASE = /^[0-9#*]$/u;
const MONGOLIAN_SELECTOR = /^[\u180B-\u180D\u180F]$/u;

type Kind = "tag" | "selector" | "single";

function kindOf(codePoint: number): Kind {
  if (codePoint >= 0xe0000 && codePoint <= 0xe007f) return "tag";
  if ((codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) {
    return "selector";
  }
  return "single";
}

/** High: can reorder a line or carry text. Medium: invisible, but can do neither alone. */
function severityOf(codePoint: number): FindingSeverity {
  const high =
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0x2028 ||
    codePoint === 0x2029 ||
    kindOf(codePoint) !== "single";
  return high ? "high" : "medium";
}

/** True when the hidden character at `index` is normal text in its context. */
function isLegitimate(chars: ReadonlyArray<string>, index: number): boolean {
  const char = chars[index] ?? "";
  const before = chars[index - 1] ?? "";
  const after = chars[index + 1] ?? "";
  if (char === "\u200D" && EMOJI_BEFORE_JOINER.test(before) && EMOJI.test(after)) return true;
  if (char === "\u200C" || char === "\u200D") {
    // Vowel marks are Script=Inherited and transparent for joining, so the
    // letter they sit on decides whether the joiner is spelling.
    let base = index - 1;
    while (base > 0 && MARK.test(chars[base] ?? "") && !JOINING_SCRIPT.test(chars[base] ?? "")) base -= 1;
    const joins = (neighbour: string) => LETTER.test(neighbour) && JOINING_SCRIPT.test(neighbour);
    return joins(chars[base] ?? "") && joins(after);
  }
  if (SELECTOR.test(char)) {
    // One selector picks a glyph for the character before it. Two in a row
    // pick nothing, and are how bytes get smuggled after ordinary text.
    if (SELECTOR.test(before) || SELECTOR.test(after) || before === "") return false;
    // Only a character with that variant takes one. Spread one per letter
    // over ordinary text, selectors carry four bits each and show nothing.
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint === 0xfe0e || codePoint === 0xfe0f) {
      // Text or emoji presentation. A digit, # or * only takes one as part
      // of a keycap.
      if (KEYCAP_BASE.test(before)) return after === "\u20E3";
      return EMOJI_BASE.test(before);
    }
    // Ideographic variants, and the standardized variants of math symbols.
    return HAN.test(before) || (codePoint === 0xfe00 && MATH.test(before));
  }
  if (MONGOLIAN_SELECTOR.test(char)) {
    const run = MONGOLIAN_SELECTOR.test(before) || MONGOLIAN_SELECTOR.test(after);
    return !run && MONGOLIAN.test(before);
  }
  return false;
}

/** Code points of the hidden characters in `text` that are not legitimate there. */
function hiddenIn(text: string, options: { readonly allowLeadingBom?: boolean } = {}): Array<number> {
  const chars = Array.from(text);
  const found: Array<number> = [];
  chars.forEach((char, index) => {
    if (!HIDDEN.test(char) || isLegitimate(chars, index)) return;
    if (char === "\uFEFF" && index === 0 && options.allowLeadingBom === true) return;
    found.push(char.codePointAt(0) ?? 0);
  });
  return found;
}

const hex = (codePoint: number) => codePoint.toString(16).toUpperCase().padStart(4, "0");

/**
 * Replace each hidden character with a visible marker. Nothing here adds or
 * removes a line, so numbered excerpts and inline anchors still line up.
 *
 * Tag characters and variation selectors collapse to a count per run: each
 * one encodes a byte, so writing them out as code points would hand the
 * hidden text to the model in a form it can decode.
 */
export function escapeHiddenCharacters(text: string): string {
  const chars = Array.from(text);
  if (!chars.some((char) => HIDDEN.test(char))) return text;
  const out: Array<string> = [];
  let run: { kind: Kind; count: number } | null = null;
  const flush = () => {
    if (run === null) return;
    const noun = run.kind === "tag" ? "tag character" : "variation selector";
    out.push(`[${run.count} hidden ${noun}${run.count === 1 ? "" : "s"}]`);
    run = null;
  };
  chars.forEach((char, index) => {
    if (!HIDDEN.test(char) || isLegitimate(chars, index)) {
      flush();
      out.push(char);
      return;
    }
    const codePoint = char.codePointAt(0) ?? 0;
    const kind = kindOf(codePoint);
    if (kind === "single") {
      flush();
      out.push(`[U+${hex(codePoint)}]`);
      return;
    }
    if (run !== null && run.kind !== kind) flush();
    run = run === null ? { kind, count: 1 } : { kind, count: run.count + 1 };
  });
  flush();
  return out.join("");
}

/** Names for the detail text, with tag and selector ranges summarised rather than spelled out. */
function describe(codePoints: Iterable<number>): string {
  const names = new Set<string>();
  for (const codePoint of codePoints) {
    const kind = kindOf(codePoint);
    if (kind === "tag") names.add("tag characters (U+E0000 to U+E007F)");
    else if (kind === "selector") names.add("runs of variation selectors");
    else names.add(`U+${hex(codePoint)} ${NAMES[codePoint] ?? "INVISIBLE CHARACTER"}`);
  }
  return [...names].join(", ");
}

/** Git writes unusual paths as a C-style quoted string with octal UTF-8 bytes. */
function unquotePath(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const bytes: Array<number> = [];
  const body = raw.slice(1, -1);
  const simple: Readonly<Record<string, string>> = {
    a: "\x07",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\v",
    '"': '"',
    "\\": "\\",
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const octal = body.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(Number.parseInt(octal, 8));
      index += 3;
      continue;
    }
    const next = body[index + 1] ?? "";
    bytes.push(...Buffer.from(simple[next] ?? next, "utf8"));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** A new-side path from a diff header, or null for a deleted file. */
function headerPath(raw: string): string | null {
  // Not trim(): it treats U+FEFF as whitespace and would erase the very
  // character the scan is looking for.
  const path = unquotePath(raw.replace(/^[ \t]+|[ \t\r]+$/g, ""));
  if (path === "/dev/null") return null;
  return path.startsWith("b/") ? path.slice(2) : path;
}

/**
 * The new-side path on a `diff --git` line, which is the only place a new
 * empty file or a mode-only change names itself. An unquoted path with spaces
 * is ambiguous here unless both sides match; renames are read from their own
 * `rename to` line instead.
 */
function gitHeaderPath(rest: string): string | null {
  const quoted = rest.match(/^(?:"(?:[^"\\]|\\.)*"|a\/\S*) ("(?:[^"\\]|\\.)*")$/);
  if (quoted?.[1]) return headerPath(quoted[1]);
  if (!rest.startsWith("a/") || (rest.length - 5) % 2 !== 0) return null;
  const path = rest.slice(2, 2 + (rest.length - 5) / 2);
  return rest === `a/${path} b/${path}` ? path : null;
}

/**
 * The new-side name a file header line introduces. Renames, copies and binary
 * files have no `+++` line, so their names arrive on these instead.
 */
function nameFromHeader(line: string): string | null {
  if (line.startsWith("diff --git ")) return gitHeaderPath(line.slice("diff --git ".length));
  if (line.startsWith("+++ ")) return headerPath(line.slice(4));
  if (line.startsWith("rename to ")) return unquotePath(line.slice("rename to ".length));
  if (line.startsWith("copy to ")) return unquotePath(line.slice("copy to ".length));
  const binary = line.match(/^Binary files .* and (.+) differ$/);
  return binary?.[1] ? headerPath(binary[1]) : null;
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly codePoints: ReadonlyArray<number>;
}

/**
 * Each kind words its detail differently on purpose. Presentation dedupe
 * merges nearby findings in one file whose title and detail overlap, so a
 * shared paragraph would fold a medium finding into a high one.
 */
const EXPLAIN: Readonly<Record<string, (subject: string, names: string) => string>> = {
  [HIDDEN_FINDING_TITLE]: (subject, names) =>
    `${subject} ${names}, which can reorder how code displays or smuggle hidden text to an AI reviewer. ` +
    "Caught by a deterministic scan of the full diff before any model call, so no panel vote weighed it.",
  [HIDDEN_FORMAT_FINDING_TITLE]: (subject, names) =>
    `${subject} invisible formatting (${names}) that can split identifiers or conceal words in plain sight. ` +
    "This came from a fixed rule, not the model, and skipped refutation.",
  [HIDDEN_NAME_FINDING_TITLE]: (subject, names) =>
    `${subject} ${names}, so the path displays differently from its bytes. Found without a model and not put to the panel.`,
};

function toFindings(
  hits: ReadonlyArray<Hit>,
  title: string,
  severity: FindingSeverity,
  subject: (count: number) => string,
): Array<ReviewFinding> {
  if (hits.length === 0) return [];
  const files = new Set(hits.map((hit) => hit.file)).size;
  const who = `${subject(hits.length)}${files > 1 ? ` across ${files} files` : ""} ${hits.length === 1 ? "contains" : "contain"}`;
  const detail = [
    EXPLAIN[title]?.(who, describe(hits.flatMap((hit) => hit.codePoints))) ?? "",
    ...(hits.length > MAX_HIDDEN_LOCATIONS ? [`The first ${MAX_HIDDEN_LOCATIONS} are listed.`] : []),
  ].join(" ");
  return hits.slice(0, MAX_HIDDEN_LOCATIONS).map((hit) => ({
    file: hit.file,
    line: hit.line,
    title,
    detail,
    severity,
    confidence: "high",
    disposition: severity === "high" ? "block" : "fix-if-quick",
    fix: "Delete the hidden characters, or write them as escape sequences such as \\u202E where the code needs them.",
    effort: "quick",
  }));
}

/** Split one hit into its high and medium code points, keeping the location. */
function bySeverity(hits: ReadonlyArray<Hit>, severity: FindingSeverity): Array<Hit> {
  return hits.flatMap((hit) => {
    const codePoints = hit.codePoints.filter((codePoint) => severityOf(codePoint) === severity);
    return codePoints.length > 0 ? [{ ...hit, codePoints }] : [];
  });
}

/**
 * Findings for hidden characters on added lines and in changed file names.
 *
 * Takes the diff as fetched, before generated hunks are stripped and before
 * truncation, so neither step can hide a character. Removed and unchanged
 * lines are not reported: the pull request did not add them, though they are
 * still escaped on the way to the model.
 */
export function findHiddenCharacters(diff: string): Array<ReviewFinding> {
  const lineHits: Array<Hit> = [];
  const nameHits: Array<Hit> = [];
  const namesSeen = new Set<string>();
  // A file's names are only known to be new-side names once its header says
  // it is not being deleted, so they wait until the next file starts.
  let pendingNames: Array<string> = [];
  let deleting = false;
  const flushNames = () => {
    if (!deleting) {
      for (const name of pendingNames) {
        if (namesSeen.has(name)) continue;
        namesSeen.add(name);
        const codePoints = hiddenIn(name);
        if (codePoints.length > 0) nameHits.push({ file: name, line: 0, codePoints });
      }
    }
    pendingNames = [];
    deleting = false;
  };
  let file: string | null = null;
  let oldLeft = 0;
  let newLeft = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("+")) {
        const codePoints = hiddenIn(line.slice(1), { allowLeadingBom: newLine === 1 });
        if (file !== null && codePoints.length > 0) lineHits.push({ file, line: newLine, codePoints });
        newLine += 1;
        newLeft -= 1;
      } else if (line.startsWith("-")) {
        oldLeft -= 1;
      } else if (line.startsWith(" ") || line === "") {
        newLine += 1;
        newLeft -= 1;
        oldLeft -= 1;
      } else if (!line.startsWith("\\")) {
        oldLeft = 0;
        newLeft = 0;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) flushNames();
    if (line.startsWith("deleted file mode")) deleting = true;
    const name = nameFromHeader(line);
    if (name !== null || line.startsWith("+++ ")) {
      if (line.startsWith("+++ ")) file = name;
      if (name !== null) pendingNames.push(name);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk?.[2]) {
      oldLeft = Number(hunk[1] ?? 1);
      newLine = Number(hunk[2]);
      newLeft = Number(hunk[3] ?? 1);
    }
  }
  flushNames();
  // A statement about the whole diff, so it stays true when a later pass
  // lists only some of these locations as new.
  const lines = (count: number) => `In this diff, ${count === 1 ? "1 added line" : `${count} added lines`}`;
  return [
    ...nameHits.flatMap((hit) =>
      toFindings(
        [hit],
        HIDDEN_NAME_FINDING_TITLE,
        hit.codePoints.some((codePoint) => severityOf(codePoint) === "high") ? "high" : "medium",
        () => "A changed file name",
      ),
    ),
    ...toFindings(bySeverity(lineHits, "high"), HIDDEN_FINDING_TITLE, "high", lines),
    ...toFindings(bySeverity(lineHits, "medium"), HIDDEN_FORMAT_FINDING_TITLE, "medium", lines),
  ];
}

/**
 * A stable digest of the hidden-character findings, folded into the reviewed
 * diff's hash. The hash covers the stripped, truncated diff, so without this
 * a push that hides a character in a lockfile or past the size limit reads
 * as unchanged and skips the scan. Empty when there is nothing to report, so
 * existing hashes stay valid.
 */
export function hiddenFingerprint(findings: ReadonlyArray<ReviewFinding>): string {
  return findings
    .map((finding) => `${finding.title}\u0000${finding.file}\u0000${finding.line}\u0000${finding.detail}`)
    .join("\n");
}
