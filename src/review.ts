/**
 * Find-then-refute review pipeline.
 *
 * The point is precision, not coverage. A cheap model will generate
 * plausible-and-wrong findings all day; a reviewer that reports five issues per
 * PR and is wrong on four trains everyone to ignore it, which is worse than
 * having no reviewer at all. So findings are generated once and then put to a
 * panel of independent skeptics, each asked to *refute* rather than confirm.
 * Only findings a majority fails to refute survive.
 *
 * That is deliberately token-hungry. Tokens are the cheap part; a reviewer
 * nobody trusts is not.
 *
 * The panel is sampled at a non-zero temperature on purpose. Independence is
 * what makes a majority vote mean anything — three votes at temperature 0 are
 * one opinion counted three times.
 */
import {
  addUsage,
  EMPTY_USAGE,
  requestCompletion,
  type ResolvedReviewProvider,
  type TokenUsage,
} from "./provider.ts";
import { HIDDEN_TITLES, escapeHiddenCharacters } from "./hidden.ts";

/**
 * Diffs are truncated rather than chunked.
 *
 * A genuinely enormous refactor is not something a cheap model reviews
 * usefully, and silently splitting it into windows produces findings with no
 * cross-file context while costing the most tokens. Truncating and saying so in
 * the comment is the honest failure mode.
 *
 * The limit is generous because the models this targets are not
 * context-constrained: 600k characters is roughly 150k tokens against DeepSeek
 * V4's 1M window. An earlier 240k limit was set by guesswork and would have
 * silently truncated the single richest case in the benchmark suite, which
 * would have quietly corrupted the comparison it exists to produce.
 */
export const MAX_DIFF_CHARACTERS = 600_000;

/** Votes per finding. Odd, so a majority always exists. */
export const REFUTATION_PANEL_SIZE = 3;

/**
 * How many panel votes run at once, after the cache-warming first vote.
 *
 * Sized against the loosened generator rather than the old one. Ten findings
 * means thirty votes, which at four-at-a-time is eight sequential rounds of a
 * reasoning model and would put a ten-PR benchmark past two hours. Eight halves
 * that. Retries cover the rate limiting this risks, and the warm-up vote keeps
 * the burst from being thirty simultaneous cache misses.
 */
const PANEL_CONCURRENCY = 8;

/**
 * One lens per panel seat, appended to the shared refute prompt.
 *
 * Three identical skeptics at temperature 1 apply the refutation grounds
 * stochastically: each one samples which grounds it takes seriously. It
 * showed in practice — "potentially breaking existing callers" names no
 * trigger, exactly what the vagueness ground exists to kill, yet only one
 * voter applied that ground and the claim survived 2-1. Assigning each seat
 * a lens makes every ground somebody's whole job, so coverage of the grounds
 * is guaranteed by construction instead of sampled. Majority rule is
 * unchanged, which means one lens alone can never sink a finding: a claim
 * that is specific, accurate, and in scope still stands 3-0.
 *
 * The lens rides at the end of the user prompt rather than in per-seat system
 * prompts because the panel's token cost lives in the shared diff prefix.
 * Distinct system prompts would give each seat its own cache miss over the
 * whole diff; a trailing suffix keeps one miss per finding.
 *
 * SEAT ORDER IS LOAD-BEARING under pair-then-tiebreak voting: seats 0 and 1
 * always vote; seat 2 only on splits. The first pair choice (checkability +
 * mechanism) sidelined the scope seat — owner of the pre-existing,
 * comment-answered, intent-restatement, and repo-characteristic grounds, the
 * highest-frequency noise-killers — and fleet keep rates jumped from a
 * measured 42% to 60-90% within a day. The pair is now mechanism + scope;
 * checkability breaks ties. "The decision function is identical" was true of
 * the arithmetic and false of seat attention.
 *
 * A lens is added scrutiny, never exclusive jurisdiction. The first version
 * read as jurisdiction, and a strictly literal model (Muse Spark) voted only
 * its own ground — which breaks the arithmetic: each ground has exactly one
 * seat, so a finding failing only one ground loses one vote and survives 1-2
 * by construction. Intent-restatements became mathematically unkillable, and
 * a claim this reviewer had hand-verified as false survived a unanimous
 * panel. Every seat must vote every ground; the lens only says where to dig
 * hardest.
 */
export const LENS_JURISDICTION_NOTE =
  "Your focus adds scrutiny; it does not narrow your duty. If the claim fails " +
  "ANY of the listed grounds, refute it, whether or not that ground is your focus.";

export const REFUTE_LENSES: ReadonlyArray<string> = [
  [
    "Your assigned focus for this vote: MECHANISM ACCURACY. Re-read the",
    "relevant hunks and trace what the code actually does. If the code's real",
    "behaviour differs from what the claim describes, refute it on that ground.",
    "When code generates code (templates, embedded JSON.stringify, eval), trace",
    "each layer separately: a mechanism true at one layer is often false at",
    "another, and a confirmed false high survived because the claim and its",
    "check both reasoned one layer short. When the claim asserts the RANGE of a",
    "value another function returns, look for that function in your evidence and",
    "check it — a confirmed false medium claimed a scale could be zero when the",
    "callee clamps zero to 1.0 one call away. If the callee is not in evidence,",
    "say so in your reason instead of assuming the range. When the claim cites a",
    "SIBLING field or call site as precedent, verify the sibling's type makes it",
    "comparable: an Option field tolerating null is not evidence that anything",
    "writes null to a bool — a confirmed bad citation inverted exactly that.",
    LENS_JURISDICTION_NOTE,
  ].join("\n"),
  [
    "Your assigned focus for this vote: SCOPE AND INTENT. Is the issue on lines",
    "this diff modifies? Is it the change's intended behaviour restated as a",
    "defect? Is it a trade-off an adjacent code comment already documents and",
    "justifies? Did the code being replaced have the same flaw, making it",
    "pre-existing? Ask directly: would this claim be equally true on the base",
    "branch? A behaviour shared by dozens of untouched fields is a repo",
    "characteristic, not a defect this diff introduced; a confirmed declined",
    "finding flagged an attribute as the cause on a field that already used it",
    "before the PR. Would a compiler, type checker, or linter already catch it?",
    "If any of these hold, refute it on that ground.",
    LENS_JURISDICTION_NOTE,
  ].join("\n"),

  [
    "Your assigned focus for this vote: CHECKABILITY. Does the claim name the",
    "concrete input, state, or sequence that triggers the failure? If it only",
    "says something 'may', 'could', or 'potentially' happens without saying",
    "when, refute it on that ground. Be hardest on predictions: a claim that",
    "something 'will fail' or 'will break CI' is only as good as its verified",
    "mechanism — every confirmed false positive so far was a confident",
    "prediction, not a description of what the code does.",
    LENS_JURISDICTION_NOTE,
  ].join("\n"),
];

/** Full-detail findings per comment; the severity-sorted tail renders as one-liners. */
export const MAX_DETAILED_FINDINGS = 5;

/** Zero for generation (reproducible), non-zero for the panel (independent). */
const FIND_TEMPERATURE = 0;
const REFUTE_TEMPERATURE = 1;

/**
 * Generator-asserted, panel-unvalidated. The panel judges whether a finding is
 * real, not how much it matters, so treat severity as the model's opinion —
 * useful for ordering and for a future gate-on-high-only mode, not as ground
 * truth. The shadow-phase audit is what validates whether its "high" means
 * anything.
 */
export type FindingSeverity = "high" | "medium" | "low";

export const SEVERITY_ORDER: Readonly<Record<FindingSeverity, number>> = {
  high: 0,
  medium: 1,
  low: 2,
};

/** Generator-asserted fix cost; drives the pacing split (quick wins now, involved batched). */
export type FindingEffort = "quick" | "involved";

/** Generator-asserted certainty; the panel still independently verifies reality. */
export type FindingConfidence = "high" | "medium" | "low";

/** Generator-asserted action lane, separating reality from fix-now urgency. */
export type FindingDisposition = "block" | "fix-if-quick" | "follow-up" | "advisory";

export const DISPOSITION_ORDER: Readonly<Record<FindingDisposition, number>> = {
  block: 0,
  "fix-if-quick": 1,
  "follow-up": 2,
  advisory: 3,
};

const CONFIDENCE_ORDER: Readonly<Record<FindingConfidence, number>> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface ReviewFinding {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly detail: string;
  readonly severity: FindingSeverity;
  readonly confidence?: FindingConfidence;
  readonly disposition?: FindingDisposition;
  /** Imperative minimal-fix direction plus the test that proves it, for agents. */
  readonly fix?: string;
  readonly effort?: FindingEffort;
  /** Which generator produced it, for the audit's which-model-earns-keeps question. Absent in single-generator mode. */
  readonly source?: string;
}

export interface RefutationVerdict {
  readonly refuted: boolean;
  readonly reason: string;
}

/**
 * Generation is tuned for recall, not precision. The panel supplies precision.
 *
 * The first version of this prompt did both jobs: it demanded only defects
 * "a senior engineer would stop the merge for", listed six categories to
 * suppress, and told the model that returning nothing was expected. Behind a
 * panel that independently suppresses again, that is two noise filters in
 * series, and it measured as near-silence: across five real pull requests
 * carrying 19 known findings it generated 4 candidates and reported 0.
 *
 * A generator that stays quiet cannot be rescued by anything downstream. So
 * this asks for anything plausible and pushes the judgement call to the
 * skeptics, which is the whole reason they exist. The exclusions that survive
 * are only the ones that would waste panel votes on questions another tool has
 * already answered.
 *
 * Demanding a concrete mechanism is what keeps this from becoming a noise
 * generator: a finding that names the triggering input and the resulting
 * failure can be checked, and one that does not can be dismissed cheaply.
 */
export const FIND_SYSTEM_PROMPT = [
  "You are a senior engineer reviewing a pull request diff. Your job is to surface",
  "every plausible defect in the changed code.",
  "",
  "A separate verification stage independently checks each finding you report, so",
  "you do not need to be certain. You need to be specific. Report anything you",
  "would want a second pair of eyes on.",
  "",
  "Look for: incorrect logic, data loss, race conditions, resource leaks, security",
  "holes, unhandled errors, missed edge cases, platform-specific assumptions, and",
  "violations of the repository conventions you are given.",
  "",
  "For each finding, name the concrete mechanism: the input, state, or sequence",
  "that triggers it, and what goes wrong as a result. A finding with no mechanism",
  "cannot be verified and will be discarded, so spend your words there.",
  "",
  "Skip only these, which waste verification effort:",
  "- Anything a linter, type checker, formatter, or compiler already catches.",
  "- Style preferences not stated in the repository conventions.",
  "- Issues on lines the diff does not modify.",
  "- Restating what the change is intended to do as though it were a defect.",
  "- A trade-off that an adjacent code comment already documents and justifies.",
  "  The comment is the author answering you in advance; read it before flagging.",
  "- Defects that pre-date this diff: if the code being replaced or extended had",
  "  the same flaw, it is pre-existing even when the diff touches those lines.",
  "- A pattern the surrounding code already uses at many unchanged call sites",
  "  (unchecked handles, a pervasive style). That is a repo convention question,",
  "  not a defect in this change.",
  "",
  "Rate each finding's severity by OUTCOME on inputs that occur in practice, not",
  "by how surprising the mechanism is:",
  '- "high": the change does not work at all, loses or corrupts data, crashes, or',
  "  is unsafe, on realistic input. A resource leak with no growth path is medium:",
  "  high must tell the reader what to read first.",
  '- "medium": a feature silently does not work, or wrong-but-recoverable output.',
  '- "low": cosmetic, diagnostic, defensive gaps, doc-versus-code mismatches.',
  "If unsure between low and medium, rate medium. A graded scorecard contained",
  "one under-rated true finding, so low is reserved for genuinely minor outcomes.",
  "If the triggering input cannot occur on real systems (impossible geometry,",
  "values a checked invariant already excludes), cap the severity at low no",
  "matter how correct the mechanism is: unreachable-but-true costs the reader",
  "attention needed for reachable defects.",
  "",
  "Every finding MUST carry the new-file line number from the hunk it concerns.",
  "A finding without a line cannot be navigated to or anchored.",
  "",
  "A claim that state is PERSISTED or DURABLE must cite where it is written: the",
  "schema, the migration, or the write site. Persistence inferred from a variable",
  "name is not evidence, and a persistence claim without a citation will be",
  "discarded.",
  "",
  "Once per review, if the diff changes behaviour and no test in it would fail",
  "without the change, report a single finding titled 'No failing test covers",
  "this change' at severity medium. Skip this for docs, config, manifests,",
  "version bumps, dependency updates, or test-only diffs — a package.json",
  "version change needs no failing test.",
  "",
  "When the diff REMOVES user-facing behaviour, report it once at severity",
  "medium as a question of intent, naming what the user loses. Clean code and",
  "updated tests do not answer whether the removal was wanted.",
  "",
  "Before reporting, test each claim against the BASE branch: would it be",
  "equally true before this diff? A behaviour the diff neither introduces nor",
  "worsens — especially one shared by many untouched fields or call sites — is",
  "a pre-existing condition. Report it, if at all, with a title starting",
  "'Pre-existing:' and severity low. A finding framed as introduced when the",
  "base behaves identically misdirects the author at the code they just wrote.",
  "",
  "When recommending a migration or automatic heal of stored data, first check",
  "whether the value is user-settable. If a legitimate user choice is",
  "indistinguishable from the bug-written value, flag the ambiguity instead of",
  "prescribing the heal — an unconditional heal would silently reverse real",
  "user decisions, the same defect class it tries to fix.",
  "",
  "Report up to 10 findings, most severe first.",
  "",
  "For each finding include a fix: one or two imperative sentences giving the",
  "MINIMAL fix direction and, when a test would prove it, the test to add. The",
  "remedy-safety rule applies to the fix text too: if stored user-settable data",
  "is involved, the fix flags the ambiguity rather than prescribing a heal.",
  'Include effort: "quick" when the fix is a few lines a competent agent lands',
  'in one attempt, "involved" when it needs design, migration, or new',
  "infrastructure.",
  'Include confidence: "high", "medium", or "low" for how strongly the cited',
  "code supports the concrete mechanism.",
  'Include disposition: "block" when merge should wait, "fix-if-quick" for a',
  'small worthwhile fix, "follow-up" for real work that should leave this PR,',
  'or "advisory" when no tracked action is warranted.',
  "",
  'Respond with JSON only: {"findings":[{"file":"path","line":123,"severity":"high",',
  '"confidence":"high","disposition":"block","effort":"quick","title":"one line","detail":"two or three sentences naming the',
  'concrete failure mechanism","fix":"imperative minimal fix and proving test"}]}',
].join("\n");

/**
 * Refutation must be grounded, not merely doubtful.
 *
 * The first version ended with "If you are uncertain, refute it." Combined with
 * majority rule that is a very high bar, because a skeptic reading a diff in
 * isolation is almost always somewhat uncertain, and two such skeptics sink a
 * finding. It showed: on a process-cleanup pull request, candidates describing
 * locale-dependent `ps` parsing and incomplete POSIX subtree kills were both
 * dropped 2-to-1, and both correspond to issues the paid reviewer flagged as
 * Major on the same lines.
 *
 * Requiring a stated reason keeps the skepticism while removing the bias.
 * "I cannot confirm this from the diff alone" stops being a rejection, which is
 * right: it is an argument about the reviewer's information, not about the
 * code. The 3-of-3 rejections under the old prompt (a claimed undefined in a
 * toast title, a variable said to be out of scope that would not have compiled)
 * are exactly the kind that still fail this version, because a concrete reason
 * they are wrong is easy to name.
 *
 * The vagueness ground closes the hole that opened up with it. Demanding a
 * specific reason to refute hands unfalsifiable claims a free pass: "other
 * callers may silently break" survived 3-0 not because anyone verified it but
 * because there is nothing specific to argue against. Generation is already
 * told to name a mechanism, so without the matching ground here the two halves
 * disagreed about what counts as a finding, and the vaguest claims sailed
 * through the gate built to stop them.
 */
export const REFUTE_SYSTEM_PROMPT = [
  "You are verifying a claimed code-review finding against the diff. Decide whether",
  "the claim is wrong.",
  "",
  "Refute it only if you can name a specific reason, one of:",
  "- The described failure cannot occur, and you can say what prevents it.",
  "- The mechanism described is inaccurate: the code actually does something else.",
  "- The issue is on lines the diff does not modify.",
  "- A linter, type checker, or compiler would already catch it.",
  "- It restates the change's intended behaviour as though it were a defect.",
  "- An adjacent code comment explicitly addresses and justifies the exact",
  "  concern the claim raises. The author answered it in advance; read the",
  "  comment above the code before letting the claim stand.",
  "- It asserts state is persisted or durable without citing the schema,",
  "  migration, or write site that persists it. Persistence inferred from a",
  "  variable name is not evidence; the most expensive false positive on",
  "  record required tracing a store to disprove exactly this.",
  "- It names no checkable mechanism: it asserts something 'may' break or 'could'",
  "  be unsafe without saying which input, state, or sequence causes it. A claim",
  "  too vague to check is too vague to act on.",
  "",
  "Do NOT refute merely because you are unsure, because the finding seems minor, or",
  "because you cannot see the rest of the codebase. Uncertainty is not refutation.",
  "If the claim is plausible and you cannot say what is wrong with it, let it stand.",
  "",
  'Respond with JSON only: {"refuted":true|false,"reason":"the specific reason it is',
  'wrong, or why it stands"}',
].join("\n");

/**
 * Conventions, then file contents, then the diff last: the diff is the thing
 * under review, and putting it at the end keeps it in the position models
 * attend to most.
 */
export function buildFindPrompt(input: {
  readonly diff: string;
  readonly conventions: string | null;
  readonly context?: string | null;
  /** Tracked files near the diff; resolves file-existence claims at source. */
  readonly inventory?: string | null;
  /**
   * Findings earlier passes already reported. Without this the generator
   * re-hunts from scratch on every push and re-derives the same neighbourhood
   * with shifted lines and rephrased titles — production showed the same
   * stuck-flag finding rediscovered pass after pass. Only the presentation
   * layer knew; now the hunter does.
   */
  readonly previousFindings?: ReadonlyArray<PreviousFinding> | null;
  /** Candidates earlier panels refuted; suppressed from regeneration. */
  readonly previousDropped?: ReadonlyArray<PreviousFinding> | null;
}): string {
  const conventions = input.conventions ? `Repository conventions:\n\n${input.conventions}\n\n` : "";
  const inventory = input.inventory ? `${input.inventory}\n\n` : "";
  const previous =
    input.previousFindings && input.previousFindings.length > 0
      ? `Already reported on earlier passes of this pull request (do NOT re-report these or close variants; hunt only what is new or materially changed):\n${input.previousFindings
          .map((finding) => `- [${finding.severity}] ${finding.title} (${finding.file})`)
          .join("\n")}\n\n`
      : "";
  const refuted =
    input.previousDropped && input.previousDropped.length > 0
      ? `Investigated on earlier passes and REFUTED by the verification panel (do NOT re-report these or rephrasings of them, unless the code at the cited location has changed since):\n${input.previousDropped
          .map((finding) => `- ${finding.title} (${finding.file})`)
          .join("\n")}\n\n`
      : "";
  const context = input.context
    ? `Full contents of the changed files, for context (the diff below is what you are reviewing):\n\n${input.context}\n\n`
    : "";
  return `${conventions}${inventory}${previous}${refuted}${context}Review this diff.\n\n\`\`\`diff\n${input.diff}\n\`\`\``;
}

/**
 * The diff comes first and the claim last, which is the opposite of how it
 * reads most naturally.
 *
 * Prompt caches key on a prefix. With the claim first, every vote for every
 * finding has a different prefix from its first tokens, so nothing is ever
 * reusable and each of the `3N` votes pays full price for the same diff. With
 * the diff first, all `3N` votes on a pull request share one long prefix and
 * differ only in a short suffix, so exactly one of them is a cache miss.
 *
 * Measured on a 25k-token diff, that is most of the bill: uncached input was
 * 62% of the cost of a real run.
 */
export function buildRefutePrompt(input: {
  readonly finding: ReviewFinding;
  readonly diff: string;
  /**
   * Full contents of the changed files, for the panel only.
   *
   * The generator does not get this by default — measured, it suppresses
   * candidate volume — but the panel only verifies, and its confirmed
   * high-severity false positive ("state.license is never refreshed") was
   * refutable by a line sitting in a changed file the panel could not see.
   * Universal negatives about nearby code are checkable exactly here.
   */
  readonly context?: string | null;
  /**
   * Sits between the diff and the claim: identical for every vote on a pull
   * request, so it extends the shared cacheable prefix rather than breaking
   * it, and it puts file-existence facts inside the panel's evidence — the
   * one confirmed post-lens-fix false positive survived precisely because
   * that fact lived outside the diff.
   */
  readonly inventory?: string | null;
}): string {
  return [
    "The diff under review:",
    "```diff",
    input.diff,
    "```",
    ...(input.context
      ? ["", "Full contents of the changed files, for verifying claims about them:", "", input.context]
      : []),
    ...(input.inventory ? ["", input.inventory] : []),
    "",
    `Claimed finding in ${input.finding.file} at line ${input.finding.line}:`,
    input.finding.title,
    input.finding.detail,
  ].join("\n");
}

/**
 * Pull a JSON object out of a model response.
 *
 * Models wrap JSON in prose or code fences even when told not to, and a
 * reviewer that throws away a whole run over a stray fence is not worth
 * running. Falls back to the outermost brace pair.
 */
export function extractJsonObject(raw: string): unknown {
  const withoutFences = raw.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "");
  const trimmed = withoutFences.trim();
  const candidates = [trimmed];

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

/** Parse findings leniently; anything malformed is dropped rather than guessed at. */
export function parseFindings(raw: string): ReadonlyArray<ReviewFinding> {
  const parsed = extractJsonObject(raw);
  if (typeof parsed !== "object" || parsed === null) return [];
  const list = (parsed as Record<string, unknown>).findings;
  if (!Array.isArray(list)) return [];

  const findings: Array<ReviewFinding> = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const file = typeof record.file === "string" ? record.file.trim() : "";
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (file.length === 0 || title.length === 0) continue;

    const severity = record.severity;
    const confidence = record.confidence;
    const disposition = record.disposition;
    findings.push({
      file,
      line: typeof record.line === "number" && Number.isFinite(record.line) ? record.line : 0,
      title,
      detail: typeof record.detail === "string" ? record.detail.trim() : "",
      // Missing or invalid rates as medium: assuming high would let a silent
      // omission block merges under a future gate, assuming low would bury it.
      severity: severity === "high" || severity === "medium" || severity === "low" ? severity : "medium",
      ...(confidence === "high" || confidence === "medium" || confidence === "low"
        ? { confidence }
        : {}),
      ...(disposition === "block" ||
      disposition === "fix-if-quick" ||
      disposition === "follow-up" ||
      disposition === "advisory"
        ? { disposition }
        : {}),
      ...(typeof record.fix === "string" && record.fix.trim().length > 0
        ? { fix: record.fix.trim() }
        : {}),
      ...(record.effort === "quick" || record.effort === "involved"
        ? { effort: record.effort }
        : {}),
    });
  }
  return findings;
}

/**
 * Parse one panel vote.
 *
 * An unreadable vote counts as a refusal to clear the finding, matching the
 * instruction the skeptic was given. Treating it as "not refuted" would let a
 * malformed response promote a finding nobody actually vouched for.
 */
export function parseVerdict(raw: string): RefutationVerdict {
  const parsed = extractJsonObject(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return { refuted: true, reason: "unparseable verdict" };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.refuted !== "boolean") {
    return { refuted: true, reason: "verdict omitted the refuted field" };
  }
  return {
    refuted: record.refuted,
    reason: typeof record.reason === "string" ? record.reason.trim() : "",
  };
}

/** A finding survives only if fewer than half the panel refuted it. */
export function survivesPanel(verdicts: ReadonlyArray<RefutationVerdict>): boolean {
  if (verdicts.length === 0) return false;
  const refutedCount = verdicts.filter((verdict) => verdict.refuted).length;
  return refutedCount * 2 <= verdicts.length - 1;
}

/**
 * Files whose diffs are machine-written: reviewing them bills large token
 * counts for near-certain noise. Production produced a severity:high finding
 * on line 1000 of a pnpm-lock.yaml — a file no human edits — and lockfile
 * hunks routinely run to thousands of lines that then ride every panel vote.
 */
const GENERATED_FILE_PATTERN =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock)$|\.(min\.js|min\.css|map|lock)$/;

/**
 * Drop generated-file hunks from a diff, disclosing what was dropped so the
 * model knows dependency changes happened without reading their lockfiles.
 */
export function stripGeneratedHunks(diff: string): {
  readonly diff: string;
  readonly stripped: ReadonlyArray<string>;
} {
  const sections = diff.split(/^(?=diff --git )/m);
  const kept: Array<string> = [];
  const stripped: Array<string> = [];
  for (const section of sections) {
    const match = section.match(/^diff --git a\/.+? b\/(.+)$/m);
    const path = match?.[1];
    if (path !== undefined && GENERATED_FILE_PATTERN.test(path)) {
      stripped.push(path);
      continue;
    }
    kept.push(section);
  }
  if (stripped.length === 0) return { diff, stripped };
  const notice = `(Generated files changed but omitted from this diff: ${stripped.join(", ")})
`;
  return { diff: notice + kept.join(""), stripped };
}

export function truncateDiff(
  diff: string,
  limit: number = MAX_DIFF_CHARACTERS,
): { readonly diff: string; readonly truncated: boolean } {
  if (diff.length <= limit) return { diff, truncated: false };
  return { diff: diff.slice(0, limit), truncated: true };
}

export const REVIEW_COMMENT_MARKER = "<!-- coderev -->";

/**
 * Machine-readable state embedded in the posted comment, base64 so no JSON
 * character sequence can terminate the HTML comment.
 *
 * The upserted comment persists across pushes, which makes it the natural
 * memory between passes. Without it every re-review presented its findings as
 * if seen for the first time: a measured pass on a 25-line follow-up fix
 * reported nine findings of which the author judged two actionable, largely
 * re-flagging the neighbourhood the previous pass had already covered.
 */
const STATE_PATTERN = /<!-- coderev:state:v1 ([A-Za-z0-9+/=]+) -->/;

export interface PreviousFinding {
  readonly file: string;
  readonly line: number;
  readonly title: string;
  readonly severity: FindingSeverity;
  readonly confidence?: FindingConfidence;
  readonly disposition?: FindingDisposition;
}

/** Refuted candidates carried in state, bounded so the block stays small. */
export const MAX_STORED_DROPPED = 20;

/**
 * Rounds a pull request gets before the reviewer goes quiet.
 *
 * Reviewing every push turned agents into a fix-review treadmill that cost a
 * full working day, so pushes stopped triggering reviews entirely. A bounded
 * count restores the follow-up pass that catches fix-introduced bugs — the
 * measured value of mid-PR review — without the treadmill. Large diffs get
 * more rounds because they genuinely iterate more.
 */
export const DEFAULT_MAX_ROUNDS = 2;
export const LARGE_DIFF_MAX_ROUNDS = 4;
export const LARGE_DIFF_CHANGED_LINES = 1000;

/** Changed lines in a unified diff, for sizing the round budget. */
export function countChangedLines(diff: string): number {
  let count = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") || line.startsWith("-")) count += 1;
  }
  return count;
}

export function maxRoundsForDiff(diff: string): number {
  return countChangedLines(diff) >= LARGE_DIFF_CHANGED_LINES
    ? LARGE_DIFF_MAX_ROUNDS
    : DEFAULT_MAX_ROUNDS;
}

/** Rounds already spent on this pull request, from the embedded state. */
export function parseRound(body: string): number {
  const match = body.match(STATE_PATTERN);
  if (!match?.[1]) return 0;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return 0;
    const round = (parsed as Record<string, unknown>).round;
    return typeof round === "number" && Number.isFinite(round) && round > 0 ? round : 0;
  } catch {
    return 0;
  }
}

export function embedState(
  findings: ReadonlyArray<PreviousFinding>,
  diffHash?: string | null,
  dropped?: ReadonlyArray<PreviousFinding>,
  round?: number,
): string {
  const strip = ({ file, line, title, severity, confidence, disposition }: PreviousFinding) => ({
    file,
    line,
    title,
    severity,
    ...(confidence ? { confidence } : {}),
    ...(disposition ? { disposition } : {}),
  });
  const payload: Record<string, unknown> = { findings: findings.map(strip) };
  if (diffHash) payload.diffHash = diffHash;
  if (dropped && dropped.length > 0) {
    payload.dropped = dropped.slice(0, MAX_STORED_DROPPED).map(strip);
  }
  if (round && round > 0) payload.round = round;
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `<!-- coderev:state:v1 ${encoded} -->`;
}

/**
 * Candidates the previous pass's panel refuted.
 *
 * Without this the drops had no memory: the generator re-derived a refuted
 * claim with a new phrasing on the next push, and the panel's temperature-1
 * dice got re-rolled until one pass kept it — observed in production as a
 * WeakSet-clone claim dropped in one pass and kept 1-of-3 the next. Churn,
 * and a slow precision leak.
 */
export function parseDroppedFindings(body: string): ReadonlyArray<PreviousFinding> | null {
  const match = body.match(STATE_PATTERN);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const list = (parsed as Record<string, unknown>).dropped;
    if (!Array.isArray(list)) return null;
    const dropped: Array<PreviousFinding> = [];
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.file !== "string" || typeof record.title !== "string") continue;
      const severity = record.severity;
      const confidence = record.confidence;
      const disposition = record.disposition;
      dropped.push({
        file: record.file,
        line: typeof record.line === "number" ? record.line : 0,
        title: record.title,
        severity:
          severity === "high" || severity === "medium" || severity === "low"
            ? severity
            : "medium",
        ...(confidence === "high" || confidence === "medium" || confidence === "low"
          ? { confidence }
          : {}),
        ...(disposition === "block" ||
        disposition === "fix-if-quick" ||
        disposition === "follow-up" ||
        disposition === "advisory"
          ? { disposition }
          : {}),
      });
    }
    return dropped;
  } catch {
    return null;
  }
}

/**
 * The diff hash the previous pass reviewed, for skipping no-op re-reviews.
 *
 * Cost is per-review, not per-pull-request: sessions push three to six times
 * per PR and every push was a full re-review. A push that does not change the
 * diff — rebases, merge-from-main, CI retries — now costs zero model calls
 * instead of a complete generation-plus-panel cycle.
 */
export function parseStoredDiffHash(body: string): string | null {
  const match = body.match(STATE_PATTERN);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const hash = (parsed as Record<string, unknown>).diffHash;
    return typeof hash === "string" && hash.length > 0 ? hash : null;
  } catch {
    return null;
  }
}

/** Previous pass's findings out of an existing comment body, or null. */
export function parsePreviousState(body: string): ReadonlyArray<PreviousFinding> | null {
  const match = body.match(STATE_PATTERN);
  if (!match?.[1]) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const list = (parsed as Record<string, unknown>).findings;
    if (!Array.isArray(list)) return null;
    const findings: Array<PreviousFinding> = [];
    for (const entry of list) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record.file !== "string" || typeof record.title !== "string") continue;
      const severity = record.severity;
      const confidence = record.confidence;
      const disposition = record.disposition;
      findings.push({
        file: record.file,
        line: typeof record.line === "number" ? record.line : 0,
        title: record.title,
        severity:
          severity === "high" || severity === "medium" || severity === "low"
            ? severity
            : "medium",
        ...(confidence === "high" || confidence === "medium" || confidence === "low"
          ? { confidence }
          : {}),
        ...(disposition === "block" ||
        disposition === "fix-if-quick" ||
        disposition === "follow-up" ||
        disposition === "advisory"
          ? { disposition }
          : {}),
      });
    }
    return findings;
  } catch {
    return null;
  }
}

/** Same-concern test across passes: same file, similar title — the pre-panel dedupe rule. */
export function matchesPrevious(
  finding: { readonly file: string; readonly title: string },
  previous: ReadonlyArray<PreviousFinding>,
): boolean {
  const tokens = titleTokens(finding.title);
  return previous.some(
    (entry) =>
      entry.file === finding.file &&
      jaccard(titleTokens(entry.title), tokens) >= DEDUPE_SIMILARITY_THRESHOLD,
  );
}

/**
 * Words that carry no identity: with them included, two phrasings of the same
 * defect ("teardown hangs due to .cmd shim" / "teardown test hangs on
 * Windows") score as different findings.
 */
const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "to", "on", "in", "of", "for", "due", "when", "may",
  "can", "could", "is", "are", "and", "or", "with", "via", "because",
]);

function titleTokens(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0 && !TITLE_STOPWORDS.has(token)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/** Titles sharing at least half their meaningful words are the same concern. */
export const DEDUPE_SIMILARITY_THRESHOLD = 0.5;

/** Looser title bar that applies only when the findings also sit near each other. */
export const DEDUPE_NEARBY_SIMILARITY = 0.25;
export const DEDUPE_NEARBY_LINES = 40;

/**
 * Same defect, phrased twice?
 *
 * Title similarity alone missed real pairs from a production scorecard:
 * "Polling may miss brief presses" and "Esc polling can miss a quick tap"
 * share two meaningful words (0.25 Jaccard), yet were the same defect posted
 * at two severities in one round. Proximity supplies the missing signal: a
 * quarter-similar title on the same file within a few dozen lines is the same
 * concern, while a quarter-similar title elsewhere in the file is not.
 */
/** Nearby findings whose title+detail text overlaps this much share a root cause. */
export const DEDUPE_BODY_SIMILARITY = 0.45;

export function sameConcern(
  a: { readonly file: string; readonly line: number; readonly title: string; readonly detail?: string },
  b: { readonly file: string; readonly line: number; readonly title: string; readonly detail?: string },
): boolean {
  if (a.file !== b.file) return false;
  const similarity = jaccard(titleTokens(a.title), titleTokens(b.title));
  if (similarity >= DEDUPE_SIMILARITY_THRESHOLD) return true;
  const nearby =
    a.line > 0 && b.line > 0 && Math.abs(a.line - b.line) <= DEDUPE_NEARBY_LINES;
  if (!nearby) return false;
  if (similarity >= DEDUPE_NEARBY_SIMILARITY) return true;
  // Root-cause pass, from a production scorecard: pairs three lines apart with
  // near-verbatim BODIES but divergent titles were posted as two findings.
  // Titles compress differently; details restating the same mechanism do not.
  const bodyOverlap = jaccard(
    titleTokens(`${a.title} ${a.detail ?? ""}`),
    titleTokens(`${b.title} ${b.detail ?? ""}`),
  );
  return bodyOverlap >= DEDUPE_BODY_SIMILARITY;
}

/**
 * Union two generators' candidates, dropping the second generator's near
 * duplicates before the panel sees them.
 *
 * Presentation dedupe (dedupeFindings) merges across files on purpose; this
 * one is deliberately narrower — same file plus similar title — because its
 * job is only to stop paying three panel votes twice for one finding phrased
 * two ways. A missed dedupe costs votes and is then merged at presentation; an
 * overeager one silently discards a distinct finding, which is worse.
 */
export function unionCandidates(
  primary: ReadonlyArray<ReviewFinding>,
  secondary: ReadonlyArray<ReviewFinding>,
): Array<ReviewFinding> {
  const union = [...primary];
  for (const candidate of secondary) {
    const existingIndex = union.findIndex((existing) => sameConcern(existing, candidate));
    if (existingIndex === -1) {
      union.push(candidate);
      continue;
    }
    // Same concern at two severities keeps the higher one: a duplicate must
    // never launder a defect down to the rating that gets skimmed past.
    const existing = union[existingIndex];
    if (existing) {
      union[existingIndex] = {
        ...existing,
        severity:
          SEVERITY_ORDER[candidate.severity] < SEVERITY_ORDER[existing.severity]
            ? candidate.severity
            : existing.severity,
        ...((candidate.disposition !== undefined &&
          (existing.disposition === undefined ||
            DISPOSITION_ORDER[candidate.disposition] < DISPOSITION_ORDER[existing.disposition]))
          ? { disposition: candidate.disposition }
          : {}),
        ...((candidate.confidence !== undefined &&
          (existing.confidence === undefined ||
            CONFIDENCE_ORDER[candidate.confidence] < CONFIDENCE_ORDER[existing.confidence]))
          ? { confidence: candidate.confidence }
          : {}),
      };
    }
  }
  return union;
}

export interface GroupedFinding {
  readonly title: string;
  readonly detail: string;
  readonly severity: FindingSeverity;
  readonly confidence?: FindingConfidence;
  readonly disposition?: FindingDisposition;
  readonly fix?: string;
  readonly effort?: FindingEffort;
  readonly locations: ReadonlyArray<{ readonly file: string; readonly line: number }>;
}

/**
 * Merge findings that describe the same defect in different places.
 *
 * A defect in a shared helper surfaces once per call site: one benchmark run
 * reported the same test-harness claim as three separate findings across three
 * test files. Three near-identical bullets read as noise even when the finding
 * is right, and noise is the one thing this tool exists to not produce. The
 * first finding in a group keeps its title and detail (generation orders by
 * severity, so the first phrasing is the one the model led with), and the
 * merged locations are listed together.
 *
 * Grouping is greedy against each group's head rather than transitive-closure,
 * so two findings that each half-match a middle one do not chain into a single
 * mega-group.
 */
export function dedupeFindings(findings: ReadonlyArray<ReviewFinding>): Array<GroupedFinding> {
  const groups: Array<{ head: ReviewFinding; grouped: GroupedFinding }> = [];
  for (const finding of findings) {
    // A model finding never joins a hidden-character group, however close
    // its title: those groups are matched across passes by exact location.
    const existing = groups.find(
      (group) =>
        HIDDEN_TITLES.has(group.head.title) === HIDDEN_TITLES.has(finding.title) &&
        (jaccard(titleTokens(group.head.title), titleTokens(finding.title)) >=
          DEDUPE_SIMILARITY_THRESHOLD ||
          sameConcern(group.head, finding)),
    );
    if (existing) {
      existing.grouped = {
        ...existing.grouped,
        // The group's face keeps the highest severity any member carried.
        severity:
          SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[existing.grouped.severity]
            ? finding.severity
            : existing.grouped.severity,
        ...((finding.disposition !== undefined &&
          (existing.grouped.disposition === undefined ||
            DISPOSITION_ORDER[finding.disposition] <
              DISPOSITION_ORDER[existing.grouped.disposition]))
          ? { disposition: finding.disposition }
          : {}),
        ...((finding.confidence !== undefined &&
          (existing.grouped.confidence === undefined ||
            CONFIDENCE_ORDER[finding.confidence] < CONFIDENCE_ORDER[existing.grouped.confidence]))
          ? { confidence: finding.confidence }
          : {}),
        locations: [...existing.grouped.locations, { file: finding.file, line: finding.line }],
      };
      continue;
    }
    groups.push({
      head: finding,
      grouped: {
        title: finding.title,
        detail: finding.detail,
        severity: finding.severity,
        ...(finding.confidence ? { confidence: finding.confidence } : {}),
        ...(finding.disposition ? { disposition: finding.disposition } : {}),
        ...(finding.fix ? { fix: finding.fix } : {}),
        ...(finding.effort ? { effort: finding.effort } : {}),
        locations: [{ file: finding.file, line: finding.line }],
      },
    });
  }
  return groups.map((group) => group.grouped);
}

export interface PassClassification {
  readonly fresh: ReadonlyArray<GroupedFinding>;
  /** Still-open findings, rendered from state — regeneration is not required. */
  readonly carried: ReadonlyArray<PreviousFinding>;
  readonly resolved: ReadonlyArray<PreviousFinding>;
}

/** How far from a changed line a cited line counts as touched by the push. */
export const RESOLUTION_PROXIMITY_LINES = 10;

/**
 * Split this pass's findings against the previous pass.
 *
 * "Resolved" is an evidence claim, not an absence claim. The first version
 * defined resolved as in-previous-but-not-in-current, which broke the moment
 * generation suppression shipped: suppressed findings can never be re-found,
 * so every finding was reported once and then falsely marked resolved on the
 * next push, fixed or not — observed in production as a re-pass posting
 * "(0 findings)" over two untouched keeps. A previous finding now resolves
 * only when the new diff actually touched its cited region (and it was not
 * re-found); otherwise it stays carried, rendered from state.
 *
 * Shared by the summary formatter and the inline planner so "new" means
 * exactly one thing: inline comments post only for fresh findings.
 */
export function classifyAgainstPrevious(
  grouped: ReadonlyArray<GroupedFinding>,
  previous: ReadonlyArray<PreviousFinding> | null,
  changedLines?: ReadonlyMap<string, ReadonlySet<number>> | null,
): PassClassification {
  if (previous === null) return { fresh: grouped, carried: [], resolved: [] };
  // Hidden-character findings are recomputed in full every pass, so their
  // stored entries are matched by exact location and never carried on their
  // own: a removed character drops out, a moved one is new, and a new site
  // in a reported file is not absorbed by an old one with the same title.
  const recomputedKey = (file: string, line: number, title: string) => `${title}\u0000${file}\u0000${line}`;
  const reported = new Set(
    previous
      .filter((entry) => HIDDEN_TITLES.has(entry.title))
      .map((entry) => recomputedKey(entry.file, entry.line, entry.title)),
  );
  const freshRecomputed = new Map<GroupedFinding, GroupedFinding>();
  const carriedRecomputed: Array<PreviousFinding> = [];
  for (const finding of grouped) {
    if (!HIDDEN_TITLES.has(finding.title)) continue;
    const isNew = (location: { readonly file: string; readonly line: number }) =>
      !reported.has(recomputedKey(location.file, location.line, finding.title));
    const newLocations = finding.locations.filter(isNew);
    if (newLocations.length > 0) freshRecomputed.set(finding, { ...finding, locations: newLocations });
    for (const location of finding.locations.filter((location) => !isNew(location))) {
      carriedRecomputed.push({
        file: location.file,
        line: location.line,
        title: finding.title,
        severity: finding.severity,
        ...(finding.confidence ? { confidence: finding.confidence } : {}),
        ...(finding.disposition ? { disposition: finding.disposition } : {}),
      });
    }
  }
  const rest = classifyByTitle(
    grouped.filter((finding) => !HIDDEN_TITLES.has(finding.title)),
    previous.filter((entry) => !HIDDEN_TITLES.has(entry.title)),
    changedLines,
  );
  // The caller sorted `grouped` by disposition and severity; keep that order
  // rather than letting the split push a medium finding above a block.
  const restFresh = new Set(rest.fresh);
  const fresh = grouped.flatMap((finding) => {
    const split = freshRecomputed.get(finding);
    if (split) return [split];
    return restFresh.has(finding) ? [finding] : [];
  });
  const rank = (entry: PreviousFinding) =>
    (entry.disposition === undefined ? 4 : DISPOSITION_ORDER[entry.disposition]) * 10 +
    SEVERITY_ORDER[entry.severity];
  const carried =
    carriedRecomputed.length === 0
      ? rest.carried
      : [...rest.carried, ...carriedRecomputed]
          .map((entry, index) => ({ entry, index }))
          .sort((a, b) => rank(a.entry) - rank(b.entry) || a.index - b.index)
          .map(({ entry }) => entry);
  return { fresh, carried, resolved: rest.resolved };
}

function classifyByTitle(
  grouped: ReadonlyArray<GroupedFinding>,
  previous: ReadonlyArray<PreviousFinding>,
  changedLines?: ReadonlyMap<string, ReadonlySet<number>> | null,
): PassClassification {
  const matchesEntry = (entry: PreviousFinding): boolean =>
    grouped.some((finding) =>
      finding.locations.some((location) =>
        matchesPrevious({ file: location.file, title: finding.title }, [entry]),
      ),
    );
  const regionTouched = (entry: PreviousFinding): boolean => {
    const lines = changedLines?.get(entry.file);
    if (!lines) return false;
    if (entry.line <= 0) return lines.size > 0;
    for (
      let line = entry.line - RESOLUTION_PROXIMITY_LINES;
      line <= entry.line + RESOLUTION_PROXIMITY_LINES;
      line += 1
    ) {
      if (lines.has(line)) return true;
    }
    return false;
  };
  const fresh = grouped.filter(
    (finding) =>
      !finding.locations.some((location) =>
        matchesPrevious({ file: location.file, title: finding.title }, previous),
      ),
  );
  const resolved = previous.filter((entry) => !matchesEntry(entry) && regionTouched(entry));
  const resolvedSet = new Set(resolved);
  return {
    fresh,
    carried: previous.filter((entry) => !resolvedSet.has(entry)),
    resolved,
  };
}

/**
 * Head-side line numbers GitHub will accept an inline comment on, per file.
 *
 * The review API rejects the ENTIRE review when any single anchor is not part
 * of the pull request's diff, so anchoring is validated here rather than
 * discovered as a 422. Added and context lines within hunks are commentable
 * on side RIGHT; deletion lines advance only the old file and are skipped.
 */
export function parseCommentableLines(diff: string): Map<string, Set<number>> {
  const commentable = new Map<string, Set<number>>();
  let currentFile: string | null = null;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch?.[1]) {
      currentFile = fileMatch[1];
      inHunk = false;
      continue;
    }
    if (line.startsWith("+++ /dev/null")) {
      currentFile = null;
      inHunk = false;
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch?.[1] && currentFile !== null) {
      newLine = Number(hunkMatch[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || currentFile === null) continue;
    if (line.startsWith("+") || line.startsWith(" ") || line === "") {
      let bucket = commentable.get(currentFile);
      if (!bucket) {
        bucket = new Set<number>();
        commentable.set(currentFile, bucket);
      }
      bucket.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // old-side line: does not advance the new file
    } else {
      inHunk = false;
    }
  }
  return commentable;
}

export interface InlineComment {
  readonly path: string;
  readonly line: number;
  readonly body: string;
}

export interface InlinePlan {
  readonly anchored: ReadonlyArray<InlineComment>;
  readonly unanchored: ReadonlyArray<GroupedFinding>;
}

function formatFindingTags(finding: {
  readonly severity: FindingSeverity;
  readonly confidence?: FindingConfidence;
  readonly disposition?: FindingDisposition;
  readonly effort?: FindingEffort;
}): string {
  return [
    ...(finding.disposition ? [`disposition: ${finding.disposition}`] : []),
    ...(finding.confidence ? [`confidence: ${finding.confidence}`] : []),
    `severity: ${finding.severity}`,
    ...(finding.effort === "quick" ? ["quick win"] : []),
  ].join(" \u00b7 ");
}

/**
 * Anchor each fresh finding at its first diff-valid location; one inline
 * comment per finding, never per location — a family finding with three call
 * sites reads as one comment naming all three, not three pings. Findings with
 * no valid anchor (line 0, out-of-hunk lines, files outside the diff) stay in
 * the summary rather than sinking the whole review post.
 */
export function planInlineComments(
  fresh: ReadonlyArray<GroupedFinding>,
  commentable: ReadonlyMap<string, ReadonlySet<number>>,
): InlinePlan {
  const anchored: Array<InlineComment> = [];
  const unanchored: Array<GroupedFinding> = [];
  for (const finding of fresh) {
    const spot = finding.locations.find(
      (location) => location.line > 0 && commentable.get(location.file)?.has(location.line),
    );
    if (!spot) {
      unanchored.push(finding);
      continue;
    }
    const others = finding.locations
      .filter((location) => location !== spot)
      .map((location) => `\`${location.file}\`${location.line > 0 ? `:${location.line}` : ""}`);
    anchored.push({
      // The real path, so the anchor matches the diff; only the text is escaped.
      path: spot.file,
      line: spot.line,
      body: escapeHiddenCharacters([
        `**${finding.title}** \u00b7 ${formatFindingTags(finding)}`,
        ...(finding.detail.length > 0 ? ["", finding.detail] : []),
        ...(finding.fix
          ? [
              "",
              `<details><summary>Prompt for AI agents</summary>`,
              "",
              `${finding.fix} Verify against the current code first; if no longer valid, skip with a brief reason. Keep the change minimal.`,
              "",
              `</details>`,
            ]
          : []),
        ...(others.length > 0 ? ["", `Also applies to: ${others.join(", ")}`] : []),
        "",
        "<sub>CodeRev \u00b7 advisory</sub>",
      ].join("\n")),
    });
  }
  return { anchored, unanchored };
}

export function formatReviewComment(input: {
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly model: string;
  /** Second generator's model, when dual-generator mode ran. */
  readonly find2Model?: string;
  /** Panel model, when it differs from the generator (hybrid routing). */
  readonly panelModel?: string;
  readonly truncated: boolean;
  /** Previous pass's findings; enables new / still-open / resolved sectioning. */
  readonly previous?: ReadonlyArray<PreviousFinding> | null;
  /** Hash of the reviewed diff, stored so an unchanged push can skip entirely. */
  readonly diffHash?: string | null;
  /** This pass's refuted candidates, carried in state so drops stay dropped. */
  readonly droppedThisPass?: ReadonlyArray<PreviousFinding> | null;
  /** Which round this pass is, stored so the next push can stop at the cap. */
  readonly round?: number;
  /** Head-side changed lines of the reviewed diff, for evidence-based resolution. */
  readonly changedLines?: ReadonlyMap<string, ReadonlySet<number>> | null;
  /** Why no model ran this pass, when only the deterministic checks did. */
  readonly modelReviewSkipped?: string;
}): string {
  const lines = [REVIEW_COMMENT_MARKER, "", "### Automated review", ""];

  // Disposition is the action contract, so it leads severity. Unknown values
  // sort last rather than being guessed into an urgent lane.
  const grouped = dedupeFindings(input.findings)
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        (a.finding.disposition === undefined ? 4 : DISPOSITION_ORDER[a.finding.disposition]) -
          (b.finding.disposition === undefined ? 4 : DISPOSITION_ORDER[b.finding.disposition]) ||
        SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] ||
        a.index - b.index,
    )
    .map((entry) => entry.finding);
  const previous = input.previous ?? null;
  const { fresh, carried, resolved } = classifyAgainstPrevious(
    grouped,
    previous,
    input.changedLines ?? null,
  );

  const renderFull = (finding: GroupedFinding, index: number) => {
    lines.push(`${index + 1}. **${finding.title}**`, "");
    const rendered = finding.locations
      .map((location) => `\`${location.file}\`${location.line > 0 ? `:${location.line}` : ""}`)
      .join(", ");
    lines.push(`   ${rendered} \u00b7 ${formatFindingTags(finding)}`, "");
    if (finding.detail.length > 0) lines.push(`   ${finding.detail}`, "");
    if (finding.fix) {
      const spot = finding.locations[0];
      const where = spot
        ? `In \`${spot.file}\`${spot.line > 0 ? ` around line ${spot.line}` : ""}: `
        : "";
      lines.push(
        "   <details><summary>Prompt for AI agents</summary>",
        "",
        `   ${where}${finding.fix} Verify against the current code first; if no longer valid, skip with a brief reason. Keep the change minimal.`,
        "",
        "   </details>",
        "",
      );
    }
  };

  // Ten full-detail findings is a wall that buries the two that matter.
  // Disposition/severity-sorted full detail for the top few; the tail gets one line each,
  // still present, still anchored inline where valid — just not each eating a
  // screen of the summary.
  const renderCapped = (list: ReadonlyArray<GroupedFinding>) => {
    const oneLiner = (finding: GroupedFinding) => {
      const where = finding.locations
        .map((location) => `\`${location.file}\`${location.line > 0 ? `:${location.line}` : ""}`)
        .join(", ");
      return `- **${finding.title}** \u2014 ${where} \u00b7 ${formatFindingTags(finding)}`;
    };
    list.slice(0, MAX_DETAILED_FINDINGS).forEach(renderFull);
    const tail = list.slice(MAX_DETAILED_FINDINGS);
    if (tail.length > 0) {
      lines.push(`Also noted:`, "");
      for (const finding of tail) lines.push(oneLiner(finding));
      lines.push("");
    }
  };

  // "No blocking issues" is only true when nothing is carried either: a pass
  // with zero new keeps over open findings must still show them, or the
  // suppressed-but-unfixed become invisible — the false all-clear again.
  if (grouped.length === 0 && carried.length === 0) {
    lines.push("No blocking issues found.");
    if (resolved.length > 0) {
      lines.push("", `Resolved since the previous pass: ${resolved.length}.`);
    }
  } else if (previous === null) {
    const noun = grouped.length === 1 ? "issue" : "issues";
    lines.push(`Found ${grouped.length} ${noun}:`, "");
    renderCapped(grouped);
  } else {
    // Re-review of a PR this tool has already commented on. Findings the
    // previous pass reported stay visible — hiding an unresolved high would be
    // the false all-clear again, quieter — but compactly, so the reader's
    // attention lands on what changed.
    if (fresh.length > 0) {
      const noun = fresh.length === 1 ? "issue" : "issues";
      lines.push(`New in this pass: ${fresh.length} ${noun}.`, "");
      renderCapped(fresh);
    } else {
      // "Nothing new" alone was misread as a clean pass in production while
      // three findings sat carried below it. The headline must say both.
      lines.push(
        carried.length > 0
          ? `Nothing new in this pass; ${carried.length} finding(s) from the previous pass still open below.`
          : "Nothing new in this pass.",
      );
    }
    if (carried.length > 0) {
      lines.push("", `Still open from earlier passes:`, "");
      for (const entry of carried) {
        const where = `\`${entry.file}\`${entry.line > 0 ? `:${entry.line}` : ""}`;
        lines.push(`- **${entry.title}** \u2014 ${where} \u00b7 ${formatFindingTags(entry)}`);
      }
    }
    if (resolved.length > 0) {
      lines.push("", `Resolved since the previous pass: ${resolved.length}.`);
    }
  }

  if (input.truncated) {
    lines.push("", "_The diff exceeded the review size limit and was truncated._");
  }
  const generators = input.find2Model
    ? `\`${input.model}\` and \`${input.find2Model}\``
    : `\`${input.model}\``;
  const panel =
    input.panelModel && input.panelModel !== input.model
      ? `a ${REFUTATION_PANEL_SIZE}-vote \`${input.panelModel}\` refutation panel`
      : `a ${REFUTATION_PANEL_SIZE}-vote refutation panel`;
  const deterministic = input.findings.some((finding) => HIDDEN_TITLES.has(finding.title));
  lines.push(
    "",
    "<sub>For coding agents: fix BLOCK and FIX IF QUICK findings now; everything " +
      "else is tracked or informational; never exceed one CodeRev fix round per PR.</sub>",
    "",
    input.modelReviewSkipped
      ? `<sub>Advisory. The model review was skipped: ${input.modelReviewSkipped}. Only the deterministic hidden-character check ran.</sub>`
      : `<sub>Advisory. Findings generated by ${generators}, each filtered through ${panel} with the changed code in evidence.` +
          (deterministic ? " Hidden-character findings come from a deterministic check and skip the panel." : "") +
          "</sub>",
    "",
    embedState(
      [
        ...fresh.flatMap((finding) =>
          finding.locations.map((location) => ({
            file: location.file,
            line: location.line,
            title: finding.title,
            severity: finding.severity,
            ...(finding.confidence ? { confidence: finding.confidence } : {}),
            ...(finding.disposition ? { disposition: finding.disposition } : {}),
          })),
        ),
        ...carried,
      ],
      input.diffHash ?? null,
      input.droppedThisPass ?? undefined,
      input.round,
    ),
  );
  // Nothing posted may carry a character the reader cannot see, whoever wrote
  // the text: a file name from the diff, or a title the model produced.
  return escapeHiddenCharacters(lines.join("\n"));
}

/** Lines of cited-file context handed to the panel around a finding's anchor. */
export const ANCHOR_CONTEXT_RADIUS = 60;

/**
 * The region a finding cites, numbered, for the panel's evidence.
 *
 * Three of four out-of-diff false positives shared one shape: the refuting
 * fact sat in the exact file-and-line region the finding itself cited — a
 * refresh() call, a detail-field check one line above the branch the claim
 * analysed — but the panel never saw it because the file was outside the
 * diff. A finding names its own coordinates; this reads them.
 *
 * Rides AFTER the claim in the vote prompt: it differs per finding, so
 * placing it in the suffix leaves the shared diff+context+inventory prefix
 * cacheable.
 */
export function formatAnchorSnippet(input: {
  readonly file: string;
  readonly line: number;
  readonly content: string;
}): string | null {
  if (input.line <= 0) return null;
  const lines = input.content.split(/\r?\n/);
  if (input.line > lines.length) return null;
  const start = Math.max(1, input.line - ANCHOR_CONTEXT_RADIUS);
  const end = Math.min(lines.length, input.line + ANCHOR_CONTEXT_RADIUS);
  const numbered = lines
    .slice(start - 1, end)
    .map((text, index) => `${start + index}: ${text}`)
    .join("\n");
  return [
    `Current contents of ${input.file} around the cited line ${input.line}:`,
    "```",
    numbered,
    "```",
  ].join("\n");
}

/**
 * Best-effort line for a finding that arrived without one.
 *
 * Production shipped high-severity findings with line 0 — unnavigable in the
 * UI and excluded from inline anchoring. The finding's own title usually
 * names identifiers that appear verbatim on the added lines it concerns, so
 * score every added line in the finding's file by title-token hits and take
 * the best. Zero stays zero when nothing matches: a wrong guess presented as
 * an anchor is worse than an honest absence.
 */
export function backfillLineFromDiff(
  finding: { readonly file: string; readonly line: number; readonly title: string },
  diff: string,
): number {
  if (finding.line > 0) return finding.line;
  const tokens = [...titleTokens(finding.title)].filter((token) => token.length >= 4);
  if (tokens.length === 0) return 0;
  let currentFile: string | null = null;
  let newLine = 0;
  let inHunk = false;
  let bestLine = 0;
  let bestHits = 0;
  for (const line of diff.split(/\r?\n/)) {
    const fileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (fileMatch?.[1]) {
      currentFile = fileMatch[1];
      inHunk = false;
      continue;
    }
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch?.[1]) {
      newLine = Number(hunkMatch[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || currentFile !== finding.file) {
      if (inHunk && (line.startsWith("+") || line.startsWith(" ") || line === "")) newLine += 1;
      continue;
    }
    if (line.startsWith("+")) {
      const haystack = line.toLowerCase();
      const hits = tokens.filter((token) => haystack.includes(token)).length;
      if (hits > bestHits) {
        bestHits = hits;
        bestLine = newLine;
      }
      newLine += 1;
    } else if (line.startsWith(" ") || line === "") {
      newLine += 1;
    } else if (!line.startsWith("-")) {
      inHunk = false;
    }
  }
  return bestHits > 0 ? bestLine : 0;
}

/**
 * Deterministic stakes classifier for a diff, so spend can follow risk.
 *
 * The ledger's expensive catches cluster where these signals live: races,
 * aborted/settled lifecycles, migrations, transactions. Uniform spending paid
 * reasoning-model rates to re-review docs pushes while re-passes on reactor
 * code ran without the precision generator. Signals are explicit keywords on
 * ADDED lines plus risky path fragments, and the result is logged, so every
 * routing decision is auditable in the run log the same way verdicts are.
 */
const RISK_CONTENT_SIGNALS = [
  "mutex",
  "lock",
  "atomic",
  "semaphore",
  "race",
  "abort",
  "spawn",
  "fork",
  "thread",
  "unsafe",
  "transaction",
  "migration",
  "watchdog",
  "settle",
  "retry",
  "timeout",
  "cancel",
  "interval",
] as const;

const RISK_PATH_SIGNALS = [
  "/migrations/",
  "/orchestration/",
  "/state/",
  "reducer",
  "adapter",
  "runtime",
  "auth",
] as const;

export interface DiffRisk {
  readonly highStakes: boolean;
  readonly signals: ReadonlyArray<string>;
}

export function assessDiffRisk(diff: string): DiffRisk {
  const signals = new Set<string>();
  for (const match of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    const path = (match[1] ?? "").toLowerCase();
    for (const fragment of RISK_PATH_SIGNALS) {
      if (path.includes(fragment)) signals.add(`path:${fragment}`);
    }
  }
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const lower = line.toLowerCase();
    for (const keyword of RISK_CONTENT_SIGNALS) {
      if (lower.includes(keyword)) signals.add(keyword);
    }
  }
  // Two distinct signals: one keyword can be incidental (a comment mentioning
  // "timeout"); two independent signals rarely are.
  return { highStakes: signals.size >= 2, signals: [...signals].sort() };
}

/** Run `tasks` with a bounded number in flight, preserving input order. */
async function mapWithConcurrency<A, B>(
  items: ReadonlyArray<A>,
  limit: number,
  run: (item: A) => Promise<B>,
): Promise<Array<B>> {
  const results = new Array<B>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await run(item);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface AdjudicatedFinding {
  readonly finding: ReviewFinding;
  readonly survived: boolean;
  readonly verdicts: ReadonlyArray<RefutationVerdict>;
  readonly usage: TokenUsage;
}

interface Vote {
  readonly findingIndex: number;
  readonly verdict: RefutationVerdict;
  readonly usage: TokenUsage;
}

async function castVote(input: {
  readonly findingIndex: number;
  readonly prompt: string;
  readonly anchorSnippet: string | null;
  readonly lens: string;
  readonly provider: ResolvedReviewProvider;
  readonly onProgress: (message: string) => void;
}): Promise<Vote> {
  try {
    const result = await requestCompletion({
      provider: input.provider,
      systemPrompt: REFUTE_SYSTEM_PROMPT,
      userPrompt: `${input.prompt}${input.anchorSnippet ? `

${input.anchorSnippet}` : ""}

${input.lens}`,
      temperature: REFUTE_TEMPERATURE,
      onRetry: (message) => input.onProgress(`  retry: ${message}`),
      onLog: (line) => input.onProgress(`  ${line}`),
    });
    return {
      findingIndex: input.findingIndex,
      verdict: parseVerdict(result.content),
      usage: result.usage,
    };
  } catch {
    // A panel member that errors out must not silently clear the finding.
    return {
      findingIndex: input.findingIndex,
      verdict: { refuted: true, reason: "vote failed" },
      usage: EMPTY_USAGE,
    };
  }
}

/**
 * Run every panel vote for a pull request, warming the prompt cache first.
 *
 * Votes are flattened across findings rather than run panel by panel, because
 * they all share one cacheable prefix (see {@link buildRefutePrompt}) and the
 * grouping only matters when the verdicts are counted at the end.
 *
 * The first vote runs alone. Firing the whole batch at once means none of them
 * has written the cache yet when the others start, so every one is a miss: a
 * real run showed 50.7% cached where the same prefix repeated 3N times should
 * approach 100%. Paying one extra sequential round to make the remaining votes
 * cache hits is a large net win, because uncached input dominates the bill.
 */
/**
 * One prompt carrying every candidate, for panels that bill by the call.
 *
 * An agentic CLI costs minutes per invocation, not milliseconds, so the
 * per-finding panel (three seats times N findings) turns a five-finding
 * review into an hour. Batching asks one seat to judge every candidate in a
 * single pass: three calls total, each ground still gets a dedicated seat,
 * and majority rule is unchanged.
 *
 * The cost is per-finding isolation. One context now holds every claim, so a
 * strong finding can colour a weak neighbour. That is a real loss, accepted
 * deliberately: the alternatives were a panel model measured to over-refute
 * (0 of 11 kept, killing confirmed-real findings) or no panel at all.
 */
export function buildBatchRefutePrompt(input: {
  readonly candidates: ReadonlyArray<ReviewFinding>;
  readonly diff: string;
  readonly context?: string | null;
  readonly inventory?: string | null;
  readonly anchorSnippets?: ReadonlyArray<string | null>;
}): string {
  const claims = input.candidates.map((finding, index) => {
    const snippet = input.anchorSnippets?.[index];
    return [
      `### Claim ${index + 1}`,
      `File: ${finding.file}${finding.line > 0 ? `:${finding.line}` : ""}`,
      `Title: ${finding.title}`,
      finding.detail.length > 0 ? `Detail: ${finding.detail}` : "",
      snippet ? `\n${snippet}` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  });

  return [
    "The diff under review:",
    "```diff",
    input.diff,
    "```",
    ...(input.context
      ? [
          "",
          "Full contents of the changed files, for verifying claims about them:",
          "",
          input.context,
        ]
      : []),
    ...(input.inventory ? ["", input.inventory] : []),
    "",
    `Below are ${input.candidates.length} claimed findings. Judge EVERY claim`,
    "independently of the others: a strong claim is no evidence for a weak one,",
    "and a weak claim is no evidence against a strong one.",
    "",
    ...claims,
    "",
    'Respond with JSON only: {"verdicts":[{"claim":1,"refuted":true,"reason":"why"}]}',
    "Include exactly one entry per claim, using the claim numbers above.",
  ].join("\n");
}

/**
 * Verdicts for a batch, indexed by claim number.
 *
 * A claim the panel never returned counts as refuted, matching the single
 * verdict parser: silence has never been allowed to promote a finding that
 * nobody vouched for.
 */
export function parseBatchVerdicts(raw: string, count: number): Array<RefutationVerdict> {
  const verdicts: Array<RefutationVerdict> = Array.from({ length: count }, () => ({
    refuted: true,
    reason: "no verdict returned for this claim",
  }));
  const parsed = extractJsonObject(raw);
  if (typeof parsed !== "object" || parsed === null) return verdicts;
  const list = (parsed as Record<string, unknown>).verdicts;
  if (!Array.isArray(list)) return verdicts;
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const claim = typeof record.claim === "number" ? record.claim : Number(record.claim);
    if (!Number.isFinite(claim) || claim < 1 || claim > count) continue;
    verdicts[claim - 1] = {
      refuted: record.refuted !== false,
      reason: typeof record.reason === "string" ? record.reason.trim() : "",
    };
  }
  return verdicts;
}

async function runPanel(input: {
  readonly candidates: ReadonlyArray<ReviewFinding>;
  readonly diff: string;
  readonly inventory?: string | null;
  readonly context?: string | null;
  /** Per-candidate cited-region snippets, parallel to `candidates`. */
  readonly anchorSnippets?: ReadonlyArray<string | null>;
  /**
   * Lenses to seat. Three is the precision default; one is the fast path,
   * where the seat is cross-model rather than a majority — a different model
   * checking the generator's work, which is the property that mattered most.
   */
  readonly seats?: number;
  /** The panel's provider — may differ from the generator's. */
  readonly provider: ResolvedReviewProvider;
  readonly onProgress: (message: string) => void;
}): Promise<ReadonlyArray<AdjudicatedFinding>> {
  const prompts = input.candidates.map((finding) =>
    buildRefutePrompt({
      finding,
      diff: input.diff,
      inventory: input.inventory ?? null,
      context: input.context ?? null,
    }),
  );
  if (input.candidates.length === 0) return [];

  // Exec providers bill by the call (minutes each), so they judge in batches:
  // one call per lens covering every candidate. HTTP providers keep the
  // per-finding path, where isolation is free.
  if ("command" in input.provider) {
    const batchPrompt = buildBatchRefutePrompt({
      candidates: input.candidates,
      diff: input.diff,
      context: input.context ?? null,
      inventory: input.inventory ?? null,
      anchorSnippets: input.anchorSnippets ?? [],
    });
    const lenses = REFUTE_LENSES.slice(0, Math.max(1, input.seats ?? REFUTE_LENSES.length));
    const seatResults = await Promise.all(
      lenses.map(async (lens, seat) => {
        try {
          const result = await requestCompletion({
            provider: input.provider,
            systemPrompt: REFUTE_SYSTEM_PROMPT,
            userPrompt: `${batchPrompt}\n\n${lens}`,
            temperature: REFUTE_TEMPERATURE,
            onRetry: (message) => input.onProgress(`  retry: ${message}`),
            onLog: (line) => input.onProgress(`  ${line}`),
          });
          return {
            verdicts: parseBatchVerdicts(result.content, input.candidates.length),
            usage: result.usage,
          };
        } catch (cause) {
          // A dead seat must not clear findings: its verdicts count as
          // refusals to vouch, exactly as an unreadable single vote does.
          input.onProgress(
            `  panel seat ${seat + 1} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
          return {
            verdicts: Array.from({ length: input.candidates.length }, () => ({
              refuted: true,
              reason: "panel seat failed",
            })),
            usage: { ...EMPTY_USAGE, reported: true } as TokenUsage,
          };
        }
      }),
    );

    const batchSeed: TokenUsage = { ...EMPTY_USAGE, reported: true };
    const panelUsage = seatResults.reduce<TokenUsage>(
      (total, seat) => addUsage(total, seat.usage),
      batchSeed,
    );
    return input.candidates.map((finding, findingIndex) => {
      const verdicts = seatResults.map(
        (seat) => seat.verdicts[findingIndex] ?? { refuted: true, reason: "missing verdict" },
      );
      return {
        finding,
        // One seat means that seat decides: majority arithmetic needs an odd
        // panel, and a single vote is trivially its own majority.
        survived: survivesPanel(verdicts),
        verdicts,
        // Batched panels bill once per seat, not once per finding; attribute
        // the whole cost to the first finding rather than inventing a split.
        usage:
          findingIndex === 0 ? panelUsage : ({ ...EMPTY_USAGE, reported: true } as TokenUsage),
      };
    });
  }

  const cast = (findingIndex: number, seat: number) =>
    castVote({
      findingIndex,
      prompt: prompts[findingIndex] ?? "",
      anchorSnippet: input.anchorSnippets?.[findingIndex] ?? null,
      lens: REFUTE_LENSES[seat % REFUTE_LENSES.length] ?? "",
      provider: input.provider,
      onProgress: input.onProgress,
    });

  // Pair-then-tiebreak: seats 0 and 1 vote together; seat 2 runs only when
  // they split. Under majority rule this is the SAME decision function as
  // always casting three votes — a third vote cannot flip a 2-0, and on a 1-1
  // the tiebreak decides either way — so roughly a third of panel spend (the
  // system's single largest cost, measured from billing) buys arithmetic
  // no-ops. Agreement-rate in production makes the saving real: most verdicts
  // are unanimous.
  const judgeFinding = async (findingIndex: number) => {
    const [a, b] = await Promise.all([cast(findingIndex, 0), cast(findingIndex, 1)]);
    const mine = [a, b];
    if (a.verdict.refuted !== b.verdict.refuted) mine.push(await cast(findingIndex, 2));
    return mine;
  };

  // First finding alone warms the shared prefix; two misses, not a burst.
  const first = await judgeFinding(0);
  const restIndexes = input.candidates.slice(1).map((_, offset) => offset + 1);
  const rest = await mapWithConcurrency(restIndexes, PANEL_CONCURRENCY / 2, judgeFinding);
  const perFinding = [first, ...rest];

  return input.candidates.map((finding, findingIndex) => {
    const mine = perFinding[findingIndex] ?? [];
    const verdicts = mine.map((entry) => entry.verdict);
    // Seeded as reported:true so `reported` stays a plain AND across the panel;
    // seeding from EMPTY_USAGE would mark every panel unreported.
    const seed: TokenUsage = { ...EMPTY_USAGE, reported: true };
    return {
      finding,
      survived: survivesPanel(verdicts),
      verdicts,
      usage: mine.reduce<TokenUsage>((total, entry) => addUsage(total, entry.usage), seed),
    };
  });
}

/**
 * Verdict reasons that mean a seat never actually voted.
 *
 * A seat that errors out is recorded as a refusal to vouch, which is the right
 * call for one dead seat among several. It is the wrong call for ALL of them:
 * every candidate is then dropped for want of a vote, the comment says nothing
 * survived, and that reads exactly like a clean review. This tool's whole
 * premise is that an all-clear from a review that did not happen is its worst
 * possible output, and the panel is a second door into it.
 *
 * A model that answered badly is not an outage — "unparseable verdict" stays
 * out of this set, because a panel that replies with rubbish still replied.
 */
const PANEL_OUTAGE_REASONS: ReadonlySet<string> = new Set([
  "panel seat failed",
  "vote failed",
  "missing verdict",
]);

/** True when no seat cast a real vote on any candidate. */
export function panelNeverVoted(judged: ReadonlyArray<AdjudicatedFinding>): boolean {
  if (judged.length === 0) return false;
  return judged.every(
    (entry) =>
      entry.verdicts.length > 0 &&
      entry.verdicts.every(
        (verdict) => verdict.refuted && PANEL_OUTAGE_REASONS.has(verdict.reason),
      ),
  );
}

export interface DiffReviewResult {
  readonly candidates: ReadonlyArray<ReviewFinding>;
  readonly findings: ReadonlyArray<ReviewFinding>;
  readonly adjudicated: ReadonlyArray<AdjudicatedFinding>;
  readonly usage: TokenUsage;
  /**
   * Usage split by stage. With hybrid routing the two stages bill at different
   * models' rates, so a single total priced at one model's rate would be
   * quietly wrong in whichever direction the rates differ.
   */
  readonly findUsage: TokenUsage;
  /** Second generator's usage; EMPTY_USAGE in single-generator mode. */
  readonly find2Usage: TokenUsage;
  readonly panelUsage: TokenUsage;
  /**
   * Why generation failed, or null if it ran.
   *
   * This exists because "the model found nothing" and "the model never
   * answered" both produce an empty findings list, and reporting the second as
   * the first is the worst failure this tool has. A clean bill of health on a
   * pull request nobody reviewed is actively misleading, and it is exactly
   * what happened the first time this ran against a real diff: the request was
   * killed mid-flight and the comment read "No blocking issues found."
   *
   * Callers must check this before presenting an empty result as good news.
   */
  readonly generationError: string | null;
  /**
   * Why the panel could not judge, or null if it did.
   *
   * Separate from generationError because the two fail differently and read
   * identically: generation produced candidates, and then every seat died, so
   * the findings list is empty for a reason that has nothing to do with the
   * code. Callers must check this before presenting an empty result as good
   * news, exactly as they must check generationError.
   */
  readonly panelError: string | null;
}

/**
 * Review one diff end to end.
 *
 * Takes a diff rather than a PR number so the benchmark can drive the identical
 * pipeline over recorded diffs. Benchmarking a different code path than the one
 * that ships would measure the wrong thing.
 */
export async function reviewDiff(input: {
  readonly diff: string;
  /**
   * Hidden-character findings from the diff as fetched (see src/hidden.ts).
   * They go straight to the result: the panel reads the same diff, so
   * injected text could otherwise argue them away.
   */
  readonly hiddenFindings?: ReadonlyArray<ReviewFinding>;
  readonly conventions: string | null;
  /** Full changed-file contents for the GENERATOR; measured to suppress candidate volume, so callers gate it behind --context. */
  readonly context?: string | null;
  /** Full changed-file contents for the PANEL; verification-only evidence, on by default in callers. */
  readonly panelContext?: string | null;
  /** Tracked-file inventory for the touched directories; see src/inventory.ts. */
  readonly inventory?: string | null;
  /** Earlier passes' findings, so generation stops re-deriving them. */
  readonly previousFindings?: ReadonlyArray<PreviousFinding> | null;
  /** Earlier passes' refuted candidates, so drops stay dropped. */
  readonly previousDropped?: ReadonlyArray<PreviousFinding> | null;
  /** Generator whose findings skip the panel; null judges everything. */
  readonly trustedSource?: string | null;
  /** Lenses to seat; defaults to the full three-seat panel. */
  readonly panelSeats?: number;
  /**
   * Reads a cited file's current contents so the panel can see the region a
   * finding names. Best-effort: null for anything unreadable. Kept as a
   * callback so this module stays IO-free and the benchmark stays honest
   * about what evidence the pipeline actually had.
   */
  readonly readCitedFile?: (file: string) => Promise<string | null>;
  readonly provider: ResolvedReviewProvider;
  /** Second generator for dual-generator mode; its candidates union with the primary's. */
  readonly find2Provider?: ResolvedReviewProvider;
  /**
   * Provider for the refutation panel; defaults to `provider`. Split because
   * the stages have opposite economics and failure modes: the strongest
   * generator measured had the most lenient panel, and the panel's 3N re-sent
   * diffs are nearly free only under aggressive cache pricing.
   */
  readonly refuteProvider?: ResolvedReviewProvider;
  readonly onProgress?: (message: string) => void;
}): Promise<DiffReviewResult> {
  const note = input.onProgress ?? (() => {});

  const hidden = input.hiddenFindings ?? [];
  if (hidden.length > 0) {
    note(`${hidden.length} line(s) or file name(s) carry hidden characters; reported without the panel.`);
  }

  const findPrompt = buildFindPrompt({
    diff: input.diff,
    conventions: input.conventions,
    context: input.context ?? null,
    inventory: input.inventory ?? null,
    previousFindings: input.previousFindings ?? null,
    previousDropped: input.previousDropped ?? null,
  });
  const generate = async (provider: ResolvedReviewProvider) =>
    requestCompletion({
      provider,
      systemPrompt: FIND_SYSTEM_PROMPT,
      userPrompt: findPrompt,
      temperature: FIND_TEMPERATURE,
      onRetry: (message) => note(`  retry: ${message}`),
      onLog: (line) => note(`  ${line}`),
    });

  // Both generators run concurrently. One failing degrades to single-generator
  // coverage with a warning; the review only counts as not-run when EVERY
  // generator failed, because a partial hunt is still a hunt while a silent
  // all-clear from a review that never happened is the worst output this tool
  // can produce.
  const [primary, secondary] = await Promise.all([
    generate(input.provider).then(
      (result) => ({ ok: true as const, result }),
      (cause: unknown) => ({
        ok: false as const,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
    input.find2Provider
      ? generate(input.find2Provider).then(
          (result) => ({ ok: true as const, result }),
          (cause: unknown) => ({
            ok: false as const,
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        )
      : Promise.resolve(null),
  ]);

  if (!primary.ok && (secondary === null || !secondary.ok)) {
    const generationError = [
      `${input.provider.model}: ${primary.error}`,
      ...(secondary !== null && !secondary.ok
        ? [`${input.find2Provider?.model ?? "find2"}: ${secondary.error}`]
        : []),
    ].join("; ");
    note(`Generation failed: ${generationError}`);
    return {
      candidates: [],
      // Deterministic, so they stand without the model: a gate still sees them.
      findings: [...hidden],
      adjudicated: [],
      usage: EMPTY_USAGE,
      findUsage: EMPTY_USAGE,
      find2Usage: EMPTY_USAGE,
      panelUsage: EMPTY_USAGE,
      generationError,
      panelError: null,
    };
  }
  if (!primary.ok) note(`Primary generator failed, continuing on the second: ${primary.error}`);
  if (secondary !== null && !secondary.ok) {
    note(`Second generator failed, continuing single-generator: ${secondary.error}`);
  }

  const tag = (findings: ReadonlyArray<ReviewFinding>, source: string) =>
    findings.map((finding) => ({ ...finding, source }));
  // A generator that returns unparseable output is indistinguishable from one
  // that found nothing: both yield an empty list at exit code 0. That
  // ambiguity hid a broken Grok integration for two days — every run read
  // "(0 + N)" and looked like a quiet model rather than a dead one. Whenever
  // a non-empty completion parses to zero findings, show what actually came
  // back so the next reader diagnoses instead of guessing.
  const parseWithDiagnostic = (
    content: string,
    model: string,
  ): ReadonlyArray<ReviewFinding> => {
    const parsed = parseFindings(content);
    if (parsed.length === 0) {
      const trimmed = content.trim();
      note(
        trimmed.length === 0
          ? `  ${model} returned an empty completion.`
          : `  ${model} returned ${trimmed.length} chars that parsed to no findings; first 300: ${trimmed.slice(0, 300).replace(/\s+/g, " ")}`,
      );
    }
    return parsed;
  };

  const primaryCandidates = primary.ok
    ? tag(parseWithDiagnostic(primary.result.content, input.provider.model), input.provider.model)
    : [];
  const secondaryCandidates =
    secondary !== null && secondary.ok && input.find2Provider
      ? tag(
          parseWithDiagnostic(secondary.result.content, input.find2Provider.model),
          input.find2Provider.model,
        )
      : [];
  const candidates = unionCandidates(primaryCandidates, secondaryCandidates).map((candidate) =>
    candidate.line > 0
      ? candidate
      : { ...candidate, line: backfillLineFromDiff(candidate, input.diff) },
  );
  // A stage that made no request has a known usage of zero, not an unknown
  // one: EMPTY_USAGE's reported:false would AND-poison every total it is
  // summed into and turn a fully-measured single-generator review into
  // "cost unknown".
  const knownZero: TokenUsage = { ...EMPTY_USAGE, reported: true };
  const found = { usage: primary.ok ? primary.result.usage : knownZero };
  const find2Usage = secondary !== null && secondary.ok ? secondary.result.usage : knownZero;
  note(
    secondaryCandidates.length > 0 || input.find2Provider
      ? `${candidates.length} candidate finding(s) (${primaryCandidates.length} + ${secondaryCandidates.length}, deduped); refuting.`
      : `${candidates.length} candidate finding(s); refuting.`,
  );

  const anchorSnippets = await Promise.all(
    candidates.map(async (candidate) => {
      if (!input.readCitedFile || candidate.line <= 0) return null;
      const content = await input.readCitedFile(candidate.file);
      if (content === null) return null;
      return formatAnchorSnippet({ file: candidate.file, line: candidate.line, content });
    }),
  );

  // Fast path: the agentic generator's own findings pass through unjudged and
  // only the second generator's candidates face a panel, seated once.
  //
  // Earned from measurement rather than taste. Grok's candidates survived the
  // three-seat panel seven times out of seven, so paying three agentic calls
  // to confirm them bought nothing but wall-clock; Muse's survived five times
  // out of fourteen, so its output is exactly where filtering pays. A whole
  // review used to take half an hour, which is its own kind of failure: a
  // reviewer nobody waits for is a reviewer nobody reads.
  const trusted = input.trustedSource ?? null;
  const passThrough =
    trusted === null ? [] : candidates.filter((candidate) => candidate.source === trusted);
  const toJudge =
    trusted === null ? candidates : candidates.filter((candidate) => candidate.source !== trusted);

  const judged = await runPanel({
    candidates: toJudge,
    diff: input.diff,
    inventory: input.inventory ?? null,
    context: input.panelContext ?? null,
    anchorSnippets,
    provider: input.refuteProvider ?? input.provider,
    ...(input.panelSeats === undefined ? {} : { seats: input.panelSeats }),
    onProgress: note,
  });

  const adjudicated: ReadonlyArray<AdjudicatedFinding> = [
    ...passThrough.map((finding) => ({
      finding,
      survived: true,
      verdicts: [] as ReadonlyArray<RefutationVerdict>,
      usage: { ...EMPTY_USAGE, reported: true } as TokenUsage,
    })),
    ...judged,
  ];
  if (passThrough.length > 0) {
    note(`${passThrough.length} finding(s) from ${trusted} passed through unjudged.`);
  }

  for (const entry of adjudicated) {
    const refuted = entry.verdicts.filter((verdict) => verdict.refuted).length;
    note(
      `  ${entry.survived ? "KEEP" : "DROP"} (${refuted}/${entry.verdicts.length} refuted) ` +
        `${entry.finding.file}:${entry.finding.line} ${entry.finding.title}` +
        (entry.finding.source ? ` [${entry.finding.source}]` : ""),
    );
    // The stated reason is the only way to tell a panel that is discriminating
    // from one that is merely suppressing. Without it, a run of DROPs looks the
    // same whether the candidates were junk or the skeptics were too harsh.
    for (const verdict of entry.verdicts) {
      if (verdict.reason.length === 0) continue;
      note(`      ${verdict.refuted ? "refuted" : "stands"}: ${verdict.reason.slice(0, 160)}`);
    }
  }

  const panelSeed: TokenUsage = { ...EMPTY_USAGE, reported: true };
  const panelUsage = adjudicated.reduce<TokenUsage>(
    (total, entry) => addUsage(total, entry.usage),
    panelSeed,
  );
  return {
    candidates,
    findings: [
      ...hidden,
      ...adjudicated.filter((entry) => entry.survived).map((entry) => entry.finding),
    ],
    adjudicated,
    usage: addUsage(addUsage(found.usage, find2Usage), panelUsage),
    findUsage: found.usage,
    find2Usage,
    panelUsage,
    generationError: null,
    // Judged, not adjudicated: the pass-through findings never went to a seat,
    // so counting them would hide an outage behind work the panel never did.
    panelError: panelNeverVoted(judged)
      ? "the refutation panel never voted; every seat failed"
      : null,
  };
}
