#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { parse, reportFailure, requireString } from "../src/args.ts";
import { reviewDeadlineMs, startReviewDeadline } from "../src/deadline.ts";
import { fetchPullRequestContext } from "../src/context.ts";
import {
  HIDDEN_TITLES,
  escapeHiddenCharacters,
  findHiddenCharacters,
  hiddenFingerprint,
} from "../src/hidden.ts";
import { buildFileInventory } from "../src/inventory.ts";
import { fileLinearFollowUps } from "../src/linear.ts";
import {
  createInlinePullRequestReview,
  fetchExistingReviewComment,
  fetchPullRequestDiff,
  upsertPullRequestComment,
} from "../src/github.ts";
import {
  estimateCostUsd,
  resolveFind2Provider,
  resolveRefuteProvider,
  resolveReviewProvider,
} from "../src/provider.ts";
import { SEVERITY_ORDER } from "../src/review.ts";
import { createHash } from "node:crypto";
import {
  type GroupedFinding,
  classifyAgainstPrevious,
  dedupeFindings,
  formatReviewComment,
  parseCommentableLines,
  maxRoundsForDiff,
  parseDroppedFindings,
  parsePreviousState,
  parseRound,
  parseStoredDiffHash,
  planInlineComments,
  reviewDiff,
  stripGeneratedHunks,
  truncateDiff,
  MAX_DIFF_CHARACTERS,
  REVIEW_COMMENT_MARKER,
} from "../src/review.ts";

const USAGE = `CodeRev: review a pull request diff with a cheap model and report what survives.

Usage:
  coderev --pr <number|url> [--post] [--conventions <path>] [--repo <dir>]

Flags:
  --pr           Pull request number or URL to review. Required.
  --post         Post the review as a PR comment instead of printing it.
  --conventions  Path to a conventions file to include in the prompt (e.g. AGENTS.md).
  --repo         Directory of the repository to review. Defaults to the working directory.
  --context      Also fetch full changed-file contents and feed them to the find stage.
  --summary-only Skip inline file/line comments; post only the summary comment.
  --force        Review even when the diff is identical to the last reviewed
                 push. Without it, an unchanged diff skips the review: same
                 input, same config would buy the same findings twice.
  --gate         Exit 3 when a surviving finding meets this severity (high,
                 medium, or low). Infra/provider failures exit 0 under a gate
                 (fail-open): a blocking check must block on findings, never
                 on outages. Without --gate, behaviour is advisory as before.
  --linear-follow-ups
                 Opt in to filing fresh, verified follow-up findings with high
                 confidence. Requires LINEAR_API_KEY and LINEAR_TEAM_ID.

Environment:
  REVIEW_API_KEY       Model API key. Falls back to the provider's own variable.
  REVIEW_PROVIDER      deepseek (default), openrouter, openai, meta, or exec.
  REVIEW_MODEL         Overrides the provider's default model.
  REVIEW_API_BASE_URL  Overrides the base URL for any OpenAI-compatible endpoint.
  REVIEW_EXEC_COMMAND  Command for exec providers; receives both prompts on stdin.

  REVIEW_REFUTE_PROVIDER / REVIEW_REFUTE_MODEL / REVIEW_REFUTE_API_KEY
                       Route the refutation panel to a different provider than
                       generation (hybrid mode). Unset = same provider.

  REVIEW_FIND2_PROVIDER / REVIEW_FIND2_MODEL / REVIEW_FIND2_API_KEY
                       Add a second generator (dual-generator mode); its
                       candidates union with the primary's before the panel.
                       Misconfiguration degrades to single-generator with a
                       warning rather than failing the review.`;

async function main(): Promise<number> {
  const { values, help } = parse({
    argv: process.argv.slice(2),
    options: {
      pr: { type: "string" },
      post: { type: "boolean", default: false },
      conventions: { type: "string" },
      repo: { type: "string" },
      context: { type: "boolean", default: false },
      "summary-only": { type: "boolean", default: false },
      gate: { type: "string" },
      force: { type: "boolean", default: false },
      "linear-follow-ups": { type: "boolean", default: false },
    },
    usage: USAGE,
  });

  if (help) {
    console.log(USAGE);
    return 0;
  }

  const pr = requireString(values, "pr", USAGE);
  const cwd = typeof values.repo === "string" ? values.repo : undefined;

  const resolution = resolveReviewProvider(process.env);
  if (!resolution.ok) throw new Error(resolution.reason);
  const provider = resolution.provider;

  const refuteResolution = resolveRefuteProvider(process.env);
  if (refuteResolution !== null && !refuteResolution.ok) throw new Error(refuteResolution.reason);
  const refuteProvider = refuteResolution?.ok ? refuteResolution.provider : undefined;

  // Degrade rather than fail: a fleet workflow may declare the second
  // generator before its key secret exists, and an enhancement must never turn
  // a working review into a broken one.
  const find2Resolution = resolveFind2Provider(process.env);
  if (find2Resolution !== null && !find2Resolution.ok) {
    console.warn(`Second generator disabled: ${find2Resolution.reason}`);
  }
  const find2Provider = find2Resolution?.ok ? find2Resolution.provider : undefined;

  const rawDiff = await fetchPullRequestDiff(pr, cwd);
  if (rawDiff.trim().length === 0) {
    console.log("Empty diff; nothing to review.");
    return 0;
  }

  // Scanned before the generated-hunk strip and the truncation below, so
  // neither can hide a character, and before any skip, so a push that only
  // adds one is still caught.
  const hiddenFindings = findHiddenCharacters(rawDiff);

  const gate = typeof values.gate === "string" ? values.gate.trim().toLowerCase() : "";
  if (gate !== "" && gate !== "high" && gate !== "medium" && gate !== "low") {
    throw new Error(`--gate must be high, medium, or low, not "${gate}"`);
  }
  // Hidden-character findings never depend on the model, so a review that is
  // skipped or that failed must not let them through a gate. Fail-open still
  // holds for outages: this blocks on findings, never on the outage.
  const hiddenGate = (why: string): number => {
    if (gate === "") return 0;
    const threshold = gate as "high" | "medium" | "low";
    const blocking = hiddenFindings.filter(
      (finding) => SEVERITY_ORDER[finding.severity] <= SEVERITY_ORDER[threshold],
    );
    if (blocking.length === 0) return 0;
    for (const finding of blocking) {
      console.error(`  ${escapeHiddenCharacters(finding.file)}:${finding.line} ${finding.title}`);
    }
    console.error(
      `Gate: ${blocking.length} hidden-character finding(s) at or above severity "${threshold}" ${why}; failing the check.`,
    );
    return 3;
  };

  // Inline comments: fresh findings only (a re-posted inline for a finding the
  // author already read is spam with an anchor), validated against the RAW
  // diff since that is what GitHub accepts anchors on. Any failure degrades to
  // the summary that just posted — inline is presentation, not the record.
  const commentable = parseCommentableLines(rawDiff);
  async function postInlineComments(fresh: ReadonlyArray<GroupedFinding>): Promise<void> {
    if (values["summary-only"] === true) return;
    // Only fix-now dispositions become inline work items. Follow-ups and
    // advisories stay in the summary (and follow-ups may be filed explicitly).
    const inlineWorthy = fresh.filter(
      (finding) => finding.disposition === "block" || finding.disposition === "fix-if-quick",
    );
    const { anchored, unanchored } = planInlineComments(inlineWorthy, commentable);
    if (unanchored.length > 0) {
      console.log(`${unanchored.length} finding(s) had no diff anchor; summary only.`);
    }
    if (anchored.length === 0) return;
    try {
      await createInlinePullRequestReview({
        pr,
        comments: anchored,
        ...(cwd === undefined ? {} : { cwd }),
      });
      console.log(`Posted ${anchored.length} inline comment(s).`);
    } catch (cause) {
      console.warn(
        `Inline comments failed, summary stands: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  const { diff: strippedDiff, stripped } = stripGeneratedHunks(rawDiff);
  if (stripped.length > 0) {
    console.log(`Omitting generated files from review: ${stripped.join(", ")}`);
  }
  const { diff, truncated } = truncateDiff(strippedDiff);
  if (truncated) console.warn(`Diff truncated to ${MAX_DIFF_CHARACTERS} characters.`);

  const conventions =
    typeof values.conventions === "string"
      ? await readFile(values.conventions, "utf8").catch(() => {
          // A missing conventions file weakens the review but must not fail it.
          console.warn(`Could not read ${String(values.conventions)}; continuing without it.`);
          return null;
        })
      : null;

  // Fetched once, used twice: the panel always gets it (verification evidence
  // for claims about nearby code), the generator only behind --context.
  const fullContext = await fetchPullRequestContext(pr, cwd, (message) => console.log(message));
  const context = values.context === true ? fullContext : null;

  // Always on: a few KB that closes the file-existence false-positive class.
  const inventory = await buildFileInventory(diff, cwd);

  // A push that does not change the diff (rebase, merge-from-main, CI retry)
  // re-buys nothing: the state block records what was reviewed, and reviewing
  // the same bytes again produces the same findings at full price. Fetched
  // before the review so the skip costs one API read, not one review.
  const diffHash = createHash("sha256")
    .update(diff, "utf8")
    .update(hiddenFingerprint(hiddenFindings), "utf8")
    .digest("hex");
  const previousBody = await fetchExistingReviewComment({
    pr,
    marker: REVIEW_COMMENT_MARKER,
    ...(cwd === undefined ? {} : { cwd }),
  });
  const previous = previousBody === null ? null : parsePreviousState(previousBody);
  const previousDropped = previousBody === null ? null : parseDroppedFindings(previousBody);

  // Bounded follow-up: the initial review plus one more pass, or up to four on
  // a large diff. Pushes stopped triggering reviews entirely after an
  // unbounded loop cost a working day; this restores the follow-up that
  // catches fix-introduced bugs without restoring the treadmill. --force and
  // the coderev label still override, because a human asking is not a loop.
  const round = (previousBody === null ? 0 : parseRound(previousBody)) + 1;
  const maxRounds = maxRoundsForDiff(diff);
  if (values.force !== true && round > maxRounds) {
    console.log(
      `Round ${round} exceeds the ${maxRounds}-round budget for this pull request; skipping (use --force or the coderev label to override).`,
    );
    // Hidden-character findings cost no model call, so the budget does not
    // hold them back. When the set changed, the comment is rewritten with
    // them, and everything from earlier passes is carried, never resolved,
    // because nothing re-reviewed it.
    const { fresh: freshHidden } = classifyAgainstPrevious(dedupeFindings(hiddenFindings), previous, null);
    const hiddenSetChanged =
      freshHidden.length > 0 ||
      (previous ?? []).some(
        (entry) =>
          HIDDEN_TITLES.has(entry.title) &&
          !hiddenFindings.some(
            (finding) =>
              finding.title === entry.title && finding.file === entry.file && finding.line === entry.line,
          ),
      );
    if (hiddenSetChanged) {
      const comment = formatReviewComment({
        findings: hiddenFindings,
        model: provider.model,
        truncated,
        previous,
        diffHash,
        // The budget stays spent, so the next push skips the same way.
        round: round - 1,
        changedLines: null,
        droppedThisPass: previousDropped ?? [],
        modelReviewSkipped: "the round budget for this pull request is spent",
      });
      if (values.post !== true) {
        console.log(`\n${comment}`);
      } else {
        try {
          await upsertPullRequestComment({
            pr,
            marker: REVIEW_COMMENT_MARKER,
            body: comment,
            ...(cwd === undefined ? {} : { cwd }),
          });
          console.log("Updated the review comment with the hidden-character check only.");
          await postInlineComments(freshHidden);
        } catch (cause) {
          // The gate below must still run: it is the part that cannot fail open.
          console.warn(
            `Posting the hidden-character findings failed: ${cause instanceof Error ? cause.message : String(cause)}`,
          );
        }
      }
    }
    return hiddenGate("while the review is over its round budget");
  }
  console.log(`Review round ${round} of ${maxRounds}.`);
  if (
    values.force !== true &&
    previousBody !== null &&
    parseStoredDiffHash(previousBody) === diffHash
  ) {
    console.log("Diff unchanged since the last reviewed push; skipping (use --force to override).");
    return hiddenGate("on an unchanged diff");
  }

  // Panel evidence for out-of-diff claims: read the file a finding cites from
  // the local checkout, best-effort. Three of four out-of-diff false positives
  // were refutable by the exact region the finding itself named.
  const { readFile: readFsFile } = await import("node:fs/promises");
  const { join, isAbsolute, normalize } = await import("node:path");
  const repoRoot = cwd ?? process.cwd();
  const readCitedFile = async (file: string): Promise<string | null> => {
    const normalized = normalize(file);
    if (isAbsolute(normalized) || normalized.startsWith("..")) return null;
    try {
      return await readFsFile(join(repoRoot, normalized), "utf8");
    } catch {
      return null;
    }
  };

  // Keep both generators on every pass. This restores the measured diversity
  // that was previously rationed by token cost.
  const rePass = previous !== null && find2Provider !== undefined;
  const passProvider = provider;
  const passFind2 = find2Provider;
  const panelProvider = refuteProvider;
  console.log(
    `Reviewing PR ${pr} with ${passProvider.model}` +
      (passFind2 ? ` + ${passFind2.model}` : "") +
      (panelProvider ? ` (panel: ${panelProvider.model})` : "") +
      (rePass ? " [re-pass: dual generator]" : "") +
      "...",
  );
  const {
    findings,
    adjudicated,
    usage,
    findUsage,
    find2Usage,
    panelUsage,
    generationError,
    panelError,
  } = await reviewDiff({
    diff,
    hiddenFindings,
    conventions,
    context,
    panelContext: fullContext,
    inventory,
    previousFindings: previous,
    previousDropped,
    // An agentic CLI costs minutes per call, so it judges once and only judges
    // what it did not write. Three seats over every candidate was a half-hour
    // review; a reviewer nobody waits for is a reviewer nobody reads.
    ...("command" in passProvider
      ? { trustedSource: passProvider.model, panelSeats: 1 }
      : {}),
    provider: passProvider,
    readCitedFile,
    ...(passFind2 ? { find2Provider: passFind2 } : {}),
    ...(panelProvider ? { refuteProvider: panelProvider } : {}),
    onProgress: (message) => console.log(message),
  });

  // With hybrid routing the stages bill at different rates; summing per-stage
  // estimates is the only honest total. Either stage unknown -> total unknown.
  const findCost = estimateCostUsd(passProvider.model, findUsage, process.env);
  const find2Cost = passFind2 ? estimateCostUsd(passFind2.model, find2Usage, process.env) : 0;
  const panelCost = estimateCostUsd((panelProvider ?? provider).model, panelUsage, process.env);
  const cost =
    findCost === null || panelCost === null || find2Cost === null
      ? null
      : findCost + find2Cost + panelCost;
  console.log(
    `Tokens: ${usage.inputTokens} in (${usage.cachedInputTokens} cached), ${usage.outputTokens} out` +
      (cost === null ? "" : ` (~$${cost.toFixed(4)})`),
  );

  // A failed review must never be posted or reported as a pass. Advisory mode
  // exits non-zero so the red job says "did not run". Under a gate the same
  // failure exits ZERO: a blocking check that goes red on provider outages
  // blocks every merge whenever the vendor hiccups, which is the incumbent's
  // failure mode with the sign flipped. Fail-open, loudly.
  if (generationError !== null) {
    if (gate !== "") {
      console.error(`Review did not run (${generationError}); gate is fail-open, not blocking.`);
      return hiddenGate("although the model review did not run");
    }
    throw new Error(`Review did not run: ${generationError}`);
  }

  // The panel is the second door into the same lie. Generation can succeed,
  // every seat can then die, and each candidate is dropped for want of a vote
  // — leaving an empty findings list that formats as "nothing survived" and
  // reads as a clean review. Refusing to post is the only honest option: the
  // candidates were never judged.
  if (panelError !== null) {
    if (gate !== "") {
      console.error(`Review did not run (${panelError}); gate is fail-open, not blocking.`);
      return hiddenGate("although the model review did not run");
    }
    throw new Error(`Review did not run: ${panelError}`);
  }

  const comment = formatReviewComment({
    findings,
    model: provider.model,
    ...(find2Provider ? { find2Model: find2Provider.model } : {}),
    ...(refuteProvider ? { panelModel: refuteProvider.model } : {}),
    truncated,
    previous,
    diffHash,
    round,
    changedLines: parseCommentableLines(rawDiff),
    // This pass's drops plus the carried older ones, newest first; embedState
    // bounds the stored list.
    droppedThisPass: [
      ...adjudicated
        .filter((entry) => !entry.survived)
        .map((entry) => ({
          file: entry.finding.file,
          line: entry.finding.line,
          title: entry.finding.title,
          severity: entry.finding.severity,
        })),
      ...(previousDropped ?? []),
    ],
  });
  if (values.post !== true) {
    console.log(`\n${comment}`);
    return 0;
  }

  const outcome = await upsertPullRequestComment({
    pr,
    marker: REVIEW_COMMENT_MARKER,
    body: comment,
    ...(cwd === undefined ? {} : { cwd }),
  });
  console.log(
    `${outcome === "updated" ? "Updated the review comment" : "Posted a review comment"} on PR ${pr} (${findings.length} finding(s)).`,
  );

  const { fresh } = classifyAgainstPrevious(dedupeFindings(findings), previous, commentable);
  if (values["linear-follow-ups"] === true) {
    const apiKey = process.env.LINEAR_API_KEY?.trim();
    const teamId = process.env.LINEAR_TEAM_ID?.trim();
    if (!apiKey || !teamId) {
      console.warn("Linear follow-up filing enabled but LINEAR_API_KEY or LINEAR_TEAM_ID is missing.");
    } else {
      try {
        const created = await fileLinearFollowUps({ findings: fresh, apiKey, teamId, pr });
        console.log(`Created ${created} Linear follow-up issue(s).`);
      } catch (cause) {
        console.warn(
          `Linear follow-up filing failed; review stands: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
    }
  }

  if (findings.length > 0) await postInlineComments(fresh);

  if (gate !== "") {
    const threshold = gate as "high" | "medium" | "low";
    const blocking = findings.filter(
      (finding) => SEVERITY_ORDER[finding.severity] <= SEVERITY_ORDER[threshold],
    );
    if (blocking.length > 0) {
      console.error(
        `Gate: ${blocking.length} finding(s) at or above severity "${threshold}" — failing the check.`,
      );
      return 3;
    }
  }
  return 0;
}

// Armed before anything else so a hang anywhere — provider, agent, or the gh
// CLI — is bounded by one number instead of by the sum of every per-call
// budget. Cancelled on the way out so a fast review is not held up by it.
const deadline = startReviewDeadline({ ms: reviewDeadlineMs(process.env) });
try {
  process.exitCode = await main().catch(reportFailure);
} finally {
  deadline.cancel();
}
