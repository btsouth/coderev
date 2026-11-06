import { spawn } from "node:child_process";
import { escapeHiddenCharacters } from "./hidden.ts";

/**
 * The model endpoint the reviewer talks to.
 *
 * HTTP providers use an OpenAI-compatible `POST /chat/completions` plus a
 * bearer token. Exec providers instead run a command with the prompt on stdin,
 * which lets a locally authenticated subscription CLI drive the same review
 * machinery without pretending it is an HTTP endpoint.
 *
 * Anthropic-compatible gateways want `/v1/messages` with a different body and a
 * different auth header. That is a second client, not a preset, and it is not
 * built until something needs it.
 *
 * Presets exist only to spare the caller from memorising base URLs. Every field
 * stays overridable, because a preset that cannot be overridden is just a
 * hardcoded value with extra steps.
 */

/**
 * Requests stream, and the timeout is on silence rather than on total duration.
 *
 * Both facts come from the same measurement. A reasoning model on a 25k-token
 * diff can spend over three minutes thinking before it emits a single token,
 * and a non-streaming request that sends nothing for that long gets killed:
 * DeepSeek returned ECONNRESET, and behind a proxy it would be a 504. The
 * identical request with `stream: true` succeeded, first byte in 0.7s and done
 * in 195s.
 *
 * So a total-duration timeout is the wrong instrument. It cannot tell a model
 * that is working from one that has hung, and tuning it means picking between
 * killing good long reviews and waiting forever on dead ones. An idle timeout
 * measures the thing that actually matters, which is whether anything is still
 * arriving. The total cap only exists to stop an infinite trickle.
 */
export const COMPLETION_IDLE_TIMEOUT_MS = 120_000;

/**
 * Separate budget for the wait before the FIRST byte of the answer.
 *
 * The idle budget assumes tokens are already flowing, so two minutes of
 * silence means the connection died. Nothing is flowing yet before the first
 * chunk: the model is reading a large diff and thinking, and a reasoning model
 * can spend longer on that than on the whole rest of the response. Arming the
 * idle timer over that window makes us hang up on a model that is working, and
 * the provider's own dashboard shows nothing wrong because the client is the
 * one that quit. That is exactly what muse-spark did on 2026-08-19: three
 * attempts, each failing at precisely 120000ms, while the same model had
 * returned five of eight candidates hours earlier.
 *
 * The budget SHRINKS to the idle value after the first attempt. Paying five
 * minutes once buys a slow model the room to start; paying it three times
 * turns one slow call into a quarter-hour and eats the review's own ceiling. A
 * model that could not start inside five minutes is not going to be rescued by
 * doing it again.
 *
 * Override the first attempt with REVIEW_FIRST_BYTE_TIMEOUT_MS.
 */
export const COMPLETION_FIRST_BYTE_TIMEOUT_MS = 300_000;

export function firstByteTimeoutMs(
  env: Readonly<Record<string, string | undefined>>,
  attempt: number,
): number {
  if (attempt > 0) return COMPLETION_IDLE_TIMEOUT_MS;
  const raw = env.REVIEW_FIRST_BYTE_TIMEOUT_MS?.trim();
  if (!raw) return COMPLETION_FIRST_BYTE_TIMEOUT_MS;
  const parsed = Number(raw);
  // A malformed override keeps the default rather than removing the bound.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : COMPLETION_FIRST_BYTE_TIMEOUT_MS;
}

/**
 * Exec providers get their own, much larger idle budget.
 *
 * The HTTP timeout assumes a streaming endpoint: tokens arrive continuously,
 * so two minutes of silence means the connection died. An agentic CLI behaves
 * nothing like that — it reads files, reasons, and prints one buffered result
 * at the end. Measured against the Grok CLI: 126s on a trivial docs diff and
 * longer on real code, with zero stdout until it finishes. Under the HTTP
 * budget every substantive review timed out three times and then gave up,
 * costing ten minutes per run and contributing no findings, while trivial
 * diffs squeaked in under the wire and looked like success.
 *
 * Eight minutes was tried and reverted once, when this budget was effectively
 * a total one: the agent emitted nothing until it finished, so any cap below
 * the whole review killed working inspections. That is no longer true —
 * narration on stderr resets the clock, so this measures actual silence.
 *
 * Ten minutes, then, is ten minutes of an agent saying nothing at all, which
 * is a stall rather than a slow review. The longest real thinking pause
 * measured between two tool calls is 255s, so this leaves better than double
 * the headroom: it must never be the thing that ends a review still doing
 * work. Six minutes was tried for exactly one build and is not worth the
 * risk — the failure it prevents costs minutes, the failure it causes costs
 * the review.
 *
 * Override with REVIEW_EXEC_IDLE_TIMEOUT_MS when a slower agent needs more.
 */
const EXEC_IDLE_TIMEOUT_MS = 600_000;

/**
 * Hard ceiling on one exec call, independent of whether it is still talking.
 *
 * Twenty minutes, because a real review needs them. Ten was tried and cut
 * generation off mid-inspection on ceiling PR 341 — the agent produced zero
 * candidates and the ten minutes bought nothing, while the same stage on PR
 * 345 legitimately ran 1031s and returned findings that posted. A budget that
 * truncates the work is worse than a slow review: it spends the whole cost and
 * delivers none of the value.
 *
 * A review is two of these calls, generation then the panel, and the observed
 * worst pair is 1031s + 571s. That fits the review's own wall clock with a few
 * minutes to spare rather than comfortably, which is the honest description.
 *
 * Override with REVIEW_EXEC_TOTAL_TIMEOUT_MS.
 */
const EXEC_TOTAL_TIMEOUT_MS = 1_200_000;

export function execTotalTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.REVIEW_EXEC_TOTAL_TIMEOUT_MS?.trim();
  if (!raw) return EXEC_TOTAL_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : EXEC_TOTAL_TIMEOUT_MS;
}

export function execIdleTimeoutMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.REVIEW_EXEC_IDLE_TIMEOUT_MS?.trim();
  if (!raw) return EXEC_IDLE_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : EXEC_IDLE_TIMEOUT_MS;
}
const COMPLETION_TOTAL_TIMEOUT_MS = 900_000;

export interface ReviewProviderPreset {
  readonly baseUrl: string;
  readonly defaultModel: string;
  /** Environment variable conventionally holding this provider's key. */
  readonly apiKeyEnvVar: string;
}

/**
 * Known providers, keyed by the value of `REVIEW_PROVIDER`.
 *
 * DeepSeek is the default because V4 Pro is the cheapest capable reviewer
 * available at time of writing and because it bills per token rather than
 * through a subscription. That matters more than it sounds: a
 * subscription-backed coding CLI generally cannot authenticate
 * non-interactively, which rules it out for CI regardless of its token value.
 */
export const REVIEW_PROVIDER_PRESETS: Readonly<Record<string, ReviewProviderPreset>> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    // Flash viability trial (2026-08-08, user-directed): V4-Flash carries the
    // whole Pro role — primary generation and the panel — at roughly a third
    // of Pro's token rates with no reasoning-token bill. Watch keep rates in
    // the run logs: the Muse-panel A/B failed by over-refuting (0/11 kept vs
    // 3/8 control) within a day, and that is the failure shape to look for.
    // Revert = restore "deepseek-v4-pro" here.
    defaultModel: "deepseek-v4-flash",
    apiKeyEnvVar: "DEEPSEEK_API_KEY",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "deepseek/deepseek-v4-pro",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-5.6-luna",
    apiKeyEnvVar: "OPENAI_API_KEY",
  },
  meta: {
    baseUrl: "https://api.meta.ai/v1",
    defaultModel: "muse-spark-1.2",
    apiKeyEnvVar: "META_API_KEY",
  },
};

export const DEFAULT_REVIEW_PROVIDER = "deepseek";

export interface ResolvedHttpReviewProvider {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiKey: string;
  readonly command?: never;
}

export interface ResolvedExecReviewProvider {
  readonly command: string;
  /** Display/audit label. Exec providers do not send this value to the CLI. */
  readonly model: string;
  readonly baseUrl?: never;
  readonly apiKey?: never;
}

export type ResolvedReviewProvider = ResolvedHttpReviewProvider | ResolvedExecReviewProvider;

/**
 * Plain data rather than a thrown error, so the resolver stays a pure function
 * and every failure mode is testable without catching.
 */
export type ReviewProviderResolution =
  | { readonly ok: true; readonly provider: ResolvedReviewProvider }
  | { readonly ok: false; readonly reason: string };

/**
 * Resolve provider settings from the environment.
 *
 * `REVIEW_API_KEY` wins over the preset's conventional variable so a workflow
 * can hold one secret named for its job rather than one named for whichever
 * vendor it currently points at. The preset variable stays supported because it
 * is what a developer already has exported locally.
 */
export function resolveReviewProvider(
  env: Readonly<Record<string, string | undefined>>,
): ReviewProviderResolution {
  const providerName = (env.REVIEW_PROVIDER ?? DEFAULT_REVIEW_PROVIDER).trim().toLowerCase();
  const preset = REVIEW_PROVIDER_PRESETS[providerName];

  if (providerName === "exec") {
    const command = env.REVIEW_EXEC_COMMAND?.trim();
    if (!command) {
      return { ok: false, reason: "REVIEW_EXEC_COMMAND must be set when REVIEW_PROVIDER is exec." };
    }
    return {
      ok: true,
      provider: { command, model: env.REVIEW_MODEL?.trim() || "exec" },
    };
  }

  const baseUrl = env.REVIEW_API_BASE_URL?.trim() || preset?.baseUrl;
  if (!baseUrl) {
    return {
      ok: false,
      reason:
        `Unknown REVIEW_PROVIDER "${providerName}" and no REVIEW_API_BASE_URL set. ` +
        `Known providers: ${Object.keys(REVIEW_PROVIDER_PRESETS).join(", ")}.`,
    };
  }

  const model = env.REVIEW_MODEL?.trim() || preset?.defaultModel;
  if (!model) {
    return {
      ok: false,
      reason: "REVIEW_MODEL must be set when REVIEW_API_BASE_URL points at a custom provider.",
    };
  }

  const apiKey = (env.REVIEW_API_KEY ?? (preset ? env[preset.apiKeyEnvVar] : undefined))?.trim();
  if (!apiKey) {
    const named = preset ? ` or ${preset.apiKeyEnvVar}` : "";
    return { ok: false, reason: `REVIEW_API_KEY${named} is not set.` };
  }

  return { ok: true, provider: { baseUrl, model, apiKey } };
}

/**
 * Resolve a distinct provider for the refutation panel, or null when the
 * panel should use the find-stage provider.
 *
 * The two stages have opposite economics and opposite failure modes, measured
 * across five benchmark runs: the strongest generator (Muse) had the most
 * lenient panel — it unanimously kept a claim a human had verified false,
 * which DeepSeek's panel killed 3-0 from the same evidence — while DeepSeek's
 * near-free cache pricing makes the 3N re-sent diffs of a panel almost
 * costless. Routing each stage to the model that is good at it is the point
 * of splitting them.
 *
 * REVIEW_MODEL and REVIEW_API_BASE_URL deliberately do NOT inherit: they
 * describe the find provider, and leaking a find-model slug to a different
 * vendor is exactly the silent-wrong-model trap (DeepSeek answers unknown
 * slugs as Flash without erroring). The refute model is REVIEW_REFUTE_MODEL
 * or the refute provider's own default; only the key falls back, because one
 * key per vendor is the common case.
 */
function resolveSecondaryProvider(
  env: Readonly<Record<string, string | undefined>>,
  prefix: "REVIEW_REFUTE" | "REVIEW_FIND2",
): ReviewProviderResolution | null {
  const anySet =
    env[`${prefix}_PROVIDER`]?.trim() ||
    env[`${prefix}_MODEL`]?.trim() ||
    env[`${prefix}_API_BASE_URL`]?.trim() ||
    env[`${prefix}_EXEC_COMMAND`]?.trim();
  if (!anySet) return null;

  const overlay: Record<string, string | undefined> = { ...env };
  overlay.REVIEW_PROVIDER = env[`${prefix}_PROVIDER`] ?? env.REVIEW_PROVIDER;
  overlay.REVIEW_MODEL = env[`${prefix}_MODEL`];
  overlay.REVIEW_API_BASE_URL = env[`${prefix}_API_BASE_URL`];
  overlay.REVIEW_API_KEY = env[`${prefix}_API_KEY`] ?? env.REVIEW_API_KEY;
  overlay.REVIEW_EXEC_COMMAND = env[`${prefix}_EXEC_COMMAND`] ?? env.REVIEW_EXEC_COMMAND;
  return resolveReviewProvider(overlay);
}

export function resolveRefuteProvider(
  env: Readonly<Record<string, string | undefined>>,
): ReviewProviderResolution | null {
  return resolveSecondaryProvider(env, "REVIEW_REFUTE");
}

/**
 * A second generator (REVIEW_FIND2_*), for dual-generator mode.
 *
 * Exists because the recall gap is a knowledge gap, not a prompt gap: the
 * highest-value finding of the first head-to-head (a DPI-aware Win32 API the
 * change should have used) came from the incumbent, and no amount of context
 * teaches a model an API it does not know. Two models hunt — measured on the
 * benchmark suite, they find substantially different things — their findings
 * union and dedupe, and one panel judges everything.
 */
export function resolveFind2Provider(
  env: Readonly<Record<string, string | undefined>>,
): ReviewProviderResolution | null {
  return resolveSecondaryProvider(env, "REVIEW_FIND2");
}

/** Join a base URL with a path without doubling or dropping slashes. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Subset of `inputTokens` served from cache, where the provider reports it. */
  readonly cachedInputTokens: number;
  /** False when the provider returned no usage block at all. */
  readonly reported: boolean;
}

export const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reported: false,
};

export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    reported: left.reported && right.reported,
  };
}

export interface ModelPrice {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  /**
   * Rate for input served from the provider's prompt cache.
   *
   * This matters more than it looks for a review workload. The refutation panel
   * re-sends the same diff on every vote, so most input tokens after the first
   * call are cache hits, and DeepSeek prices those roughly 120x below a cache
   * miss. Charging them at the miss rate would overstate a cache-friendly
   * provider's cost badly enough to pick the wrong model.
   *
   * Omitted where no published rate was verified. Missing means cached tokens
   * bill at the full input rate, which overstates cost rather than flattering
   * it. An invented discount would be the worse error.
   */
  readonly cachedInputPerMillion?: number;
}

/**
 * Per-million-token rates, used only to turn measured tokens into a dollar
 * figure in the benchmark report.
 *
 * These rot. Vendors cut prices without notice, so treat any cost column as an
 * estimate and re-check the vendor page before making a purchasing decision on
 * it. `REVIEW_PRICE_IN`, `REVIEW_PRICE_OUT`, and `REVIEW_PRICE_CACHED_IN`
 * override an entry without editing this file.
 *
 * Verified 2026-08-05.
 */
const DEEPSEEK_V4_FLASH: ModelPrice = {
  // Reconciled against a real DeepSeek billing export (309 requests, 34.4M
  // input tokens): these three rates reproduce the invoiced total exactly, to
  // the tenth of a cent, on every day in the period.
  inputPerMillion: 0.14,
  outputPerMillion: 0.28,
  cachedInputPerMillion: 0.0028,
};

const DEEPSEEK_V4_PRO: ModelPrice = {
  inputPerMillion: 0.435,
  outputPerMillion: 0.87,
  // From published rates, NOT reconciled against an invoice. Treat with more
  // suspicion than the Flash numbers: it implies cache hits cost 0.8% of a
  // miss, where Flash's verified ratio is 2%. Re-check once a Pro run appears
  // in a billing export.
  cachedInputPerMillion: 0.003625,
};

export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = {
  "deepseek-v4-pro": DEEPSEEK_V4_PRO,
  "deepseek-v4-flash": DEEPSEEK_V4_FLASH,
  "deepseek/deepseek-v4-pro": DEEPSEEK_V4_PRO,
  "deepseek/deepseek-v4-flash": DEEPSEEK_V4_FLASH,
  "gpt-5.6-luna": { inputPerMillion: 0.2, outputPerMillion: 1.2 },
  "openai/gpt-5.6-luna": { inputPerMillion: 0.2, outputPerMillion: 1.2 },
  // Meta Model API rates from launch coverage, 2026-08-05: NOT yet reconciled
  // against an invoice. The contributor tier's discount is paid for with
  // permission for Meta to train on prompts and completions, which for a
  // reviewer means the diffs under review; it publishes no cached rate, so
  // cached tokens bill at full input rate here, overstating rather than
  // flattering it.
  "muse-spark-1.2": {
    inputPerMillion: 1.25,
    outputPerMillion: 4.25,
    cachedInputPerMillion: 0.15,
  },
  "muse-spark-1.2-contributor": { inputPerMillion: 0.1, outputPerMillion: 0.2 },
};

/** Dollar cost for measured usage, or null when it cannot be known honestly. */
export function estimateCostUsd(
  model: string,
  usage: TokenUsage,
  env: Readonly<Record<string, string | undefined>> = {},
): number | null {
  if (!usage.reported) return null;
  const overrideIn = Number(env.REVIEW_PRICE_IN);
  const overrideOut = Number(env.REVIEW_PRICE_OUT);
  const overrideCached = Number(env.REVIEW_PRICE_CACHED_IN);
  const preset = MODEL_PRICING[model.trim().toLowerCase()];

  const inputPerMillion = Number.isFinite(overrideIn) ? overrideIn : preset?.inputPerMillion;
  const outputPerMillion = Number.isFinite(overrideOut) ? overrideOut : preset?.outputPerMillion;
  if (inputPerMillion === undefined || outputPerMillion === undefined) return null;

  // Clamped because a provider reporting more cached tokens than input tokens
  // would otherwise produce a negative uncached count and undercharge.
  const cachedTokens = Math.min(Math.max(usage.cachedInputTokens, 0), usage.inputTokens);
  const cachedPerMillion = Number.isFinite(overrideCached)
    ? overrideCached
    : (preset?.cachedInputPerMillion ?? inputPerMillion);

  return (
    ((usage.inputTokens - cachedTokens) / 1_000_000) * inputPerMillion +
    (cachedTokens / 1_000_000) * cachedPerMillion +
    (usage.outputTokens / 1_000_000) * outputPerMillion
  );
}

export interface CompletionResult {
  readonly content: string;
  readonly usage: TokenUsage;
}

export interface CompletionRequest {
  readonly provider: ResolvedReviewProvider;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /**
   * Higher values buy independence between refutation votes. A panel of
   * skeptics sampled at temperature 0 returns the same vote N times, which
   * looks like agreement but is one opinion counted repeatedly.
   */
  readonly temperature: number;
  /** Called when a transient failure is about to be retried. */
  readonly onRetry?: (message: string) => void;
  /** Live progress lines from an exec provider's stderr. */
  readonly onLog?: (line: string) => void;
}

/** Read usage out of a response body without trusting its shape. */
export function parseUsage(body: unknown): TokenUsage {
  if (typeof body !== "object" || body === null) return EMPTY_USAGE;
  const usage = (body as Record<string, unknown>).usage;
  if (typeof usage !== "object" || usage === null) return EMPTY_USAGE;
  const record = usage as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

  // OpenAI nests its cached count; DeepSeek reports it flat AND nested, with
  // the same value in both. Taking the larger reads either vendor correctly;
  // summing them double-counts every DeepSeek call, which reports more cached
  // tokens than the request had input tokens and understates cost by ~2x once
  // the impossible total is clamped back down.
  const details = record.prompt_tokens_details;
  const nestedCached =
    typeof details === "object" && details !== null
      ? num((details as Record<string, unknown>).cached_tokens)
      : 0;

  return {
    inputTokens: num(record.prompt_tokens),
    outputTokens: num(record.completion_tokens),
    cachedInputTokens: Math.max(num(record.prompt_cache_hit_tokens), nestedCached),
    reported: true,
  };
}

/** Read the assistant message out of a response body without trusting its shape. */
export function parseContent(body: unknown): string {
  if (typeof body !== "object" || body === null) return "";
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (typeof first !== "object" || first === null) return "";
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return "";
  const content = (message as Record<string, unknown>).content;
  return typeof content === "string" ? content : "";
}

export class ProviderRequestError extends Error {
  constructor(detail: string) {
    super(`Model request failed: ${detail}`);
    this.name = "ProviderRequestError";
  }
}

/**
 * Fold one server-sent-events line into the accumulating result.
 *
 * Exported for tests: stream assembly is the part most likely to break against
 * a provider that formats its chunks slightly differently, and it is not worth
 * a live API call to check.
 */
export function applyStreamLine(
  line: string,
  state: { content: string; usage: TokenUsage },
): void {
  if (!line.startsWith("data:")) return;
  const payload = line.slice(5).trim();
  if (payload.length === 0 || payload === "[DONE]") return;

  let chunk: unknown;
  try {
    chunk = JSON.parse(payload);
  } catch {
    // A malformed chunk mid-stream is not worth discarding a whole review over.
    return;
  }
  if (typeof chunk !== "object" || chunk === null) return;
  const record = chunk as Record<string, unknown>;

  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0];
    if (typeof first === "object" && first !== null) {
      const delta = (first as Record<string, unknown>).delta;
      if (typeof delta === "object" && delta !== null) {
        const piece = (delta as Record<string, unknown>).content;
        if (typeof piece === "string") state.content += piece;
      }
    }
  }

  // Usage arrives on its own final chunk when the provider supports
  // stream_options.include_usage. Providers that ignore it leave usage
  // unreported, which surfaces as an unknown cost rather than a free one.
  if (record.usage !== undefined && record.usage !== null) {
    state.usage = parseUsage(record);
  }
}

/**
 * Statuses worth trying again.
 *
 * 429 is a rate limit and 5xx is the provider's problem, both of which usually
 * clear on their own. 4xx otherwise means the request itself is wrong (bad key,
 * unknown model, malformed body) and retrying just burns time and money on the
 * same rejection.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export class RetryableProviderError extends ProviderRequestError {
  constructor(detail: string) {
    super(detail);
    this.name = "RetryableProviderError";
  }
}

const RETRY_DELAYS_MS = [2_000, 8_000, 20_000];

/**
 * Retry transient failures with backoff.
 *
 * A benchmark makes hundreds of calls over an hour or more, so a single 429 or
 * a dropped socket is close to certain. Without this, one blip either kills a
 * whole review or silently converts a panel vote into a refutation, which
 * quietly biases the result toward dropping findings.
 */
export async function requestCompletion(request: CompletionRequest): Promise<CompletionResult> {
  // Every prompt leaves through here, whatever route its text took in: the
  // diff, changed-file contents, cited excerpts, the file inventory, the
  // conventions file. Escaping at this one point covers routes added later.
  const input: CompletionRequest = {
    ...request,
    systemPrompt: escapeHiddenCharacters(request.systemPrompt),
    userPrompt: escapeHiddenCharacters(request.userPrompt),
  };
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await requestCompletionOnce(input, attempt);
    } catch (cause) {
      lastError = cause;
      const retryable = cause instanceof RetryableProviderError;
      const delay = RETRY_DELAYS_MS[attempt];
      if (!retryable || delay === undefined) break;
      input.onRetry?.(`${(cause as Error).message}; retrying in ${delay / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function requestCompletionOnce(
  input: CompletionRequest,
  attempt = 0,
): Promise<CompletionResult> {
  if ("command" in input.provider) return requestExecCompletionOnce(input);

  const controller = new AbortController();
  const total = setTimeout(() => controller.abort(), COMPLETION_TOTAL_TIMEOUT_MS);
  const firstByteMs = firstByteTimeoutMs(process.env, attempt);
  let idle: NodeJS.Timeout | undefined;
  // Which clock is running decides what the failure MEANS, so the two are
  // never collapsed: "it never started" and "it stopped mid-answer" want
  // different fixes, and for a year they produced the same sentence.
  let sawFirstByte = false;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(
      () => controller.abort(),
      sawFirstByte ? COMPLETION_IDLE_TIMEOUT_MS : firstByteMs,
    );
  };

  try {
    touch();
    const response = await fetch(joinUrl(input.provider.baseUrl, "chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${input.provider.apiKey}`,
      },
      body: JSON.stringify({
        model: input.provider.model,
        temperature: input.temperature,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
      }),
      signal: controller.signal,
    }).catch((cause: unknown) => {
      // The budget can run out here too, before a single response header
      // arrives, and the raw AbortError says only "This operation was
      // aborted" — which reads like a bug in us rather than a provider that
      // never answered.
      if (controller.signal.aborted) {
        throw new RetryableProviderError(
          `no response headers in ${firstByteMs}ms (the model never started answering)`,
        );
      }
      // Connection resets and DNS blips are exactly what backoff is for.
      throw new RetryableProviderError(cause instanceof Error ? cause.message : String(cause));
    });

    if (!response.ok) {
      // Body often carries the actual reason (bad key, unknown model, no
      // credit), and losing it turns every failure into an opaque status code.
      const detail = await response.text().catch(() => "");
      const message = `HTTP ${response.status} ${detail.slice(0, 300)}`;
      throw isRetryableStatus(response.status)
        ? new RetryableProviderError(message)
        : new ProviderRequestError(message);
    }
    if (response.body === null) throw new ProviderRequestError("response had no body");

    const state = { content: "", usage: EMPTY_USAGE };
    const decoder = new TextDecoder();
    let buffered = "";

    try {
      for await (const part of response.body) {
        sawFirstByte = true;
        touch();
        buffered += decoder.decode(part as Uint8Array, { stream: true });
        const lines = buffered.split("\n");
        // The trailing element is whatever arrived after the last newline, so
        // it is an incomplete line and must wait for the next chunk.
        buffered = lines.pop() ?? "";
        for (const line of lines) applyStreamLine(line, state);
      }
    } catch (cause) {
      if (!controller.signal.aborted) {
        throw new RetryableProviderError(
          `stream failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        );
      }
      throw new RetryableProviderError(
        sawFirstByte
          ? `stream went quiet for ${COMPLETION_IDLE_TIMEOUT_MS}ms after ${state.content.length} characters`
          : `no first byte in ${firstByteMs}ms (the model never started answering)`,
      );
    }
    applyStreamLine(buffered, state);
    if (state.content.trim().length === 0) {
      throw new ProviderRequestError("response contained no completion");
    }

    return { content: state.content, usage: state.usage };
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
}

/** Run a subscription-authenticated CLI with the complete prompt on stdin. */
async function requestExecCompletionOnce(input: CompletionRequest): Promise<CompletionResult> {
  if (!("command" in input.provider)) throw new ProviderRequestError("exec provider was not resolved");
  const execIdleMs = execIdleTimeoutMs(process.env);
  const execTotalMs = execTotalTimeoutMs(process.env);
  const command = input.provider.command;

  return new Promise<CompletionResult>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let stderrLine = "";
    let settled = false;
    let idle: NodeJS.Timeout | undefined;
    const terminate = () => {
      if (process.platform === "win32" && child.pid !== undefined) {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        }).unref();
      } else {
        child.kill("SIGKILL");
      }
    };

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      clearTimeout(total);
      callback();
    };
    const failStalled = () => {
      terminate();
      finish(() =>
        reject(
          new ProviderRequestError(
            `CLI produced no output for ${execIdleMs}ms; not retried (silence for a full budget is not transient)`,
          ),
        ),
      );
    };
    const touch = () => {
      if (settled) return;
      clearTimeout(idle);
      idle = setTimeout(failStalled, execIdleMs);

    };
    // Deliberately NOT retryable. A run that exhausted its total budget will
    // exhaust it again, so retrying turns one slow review into three: with the
    // batched panel's four calls that is hours of held runners, which is
    // exactly how five pull requests ended up queued behind one agent.
    const total = setTimeout(() => {
      terminate();
      finish(() =>
        reject(
          new ProviderRequestError(
            `CLI exceeded ${execTotalMs}ms total; not retried (a budget that blew once will blow again)`,
          ),
        ),
      );
    }, execTotalMs);

    touch();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      touch();
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      // Narration counts as life. The wrapper prints the agent's tool calls on
      // stderr and its answer on stdout, and stdout stays empty until the very
      // end — so watching stdout alone, a review that had read thirty-three
      // files across thirteen minutes was declared to have "produced no
      // stdout", killed, and reported as a failure, while the job log was
      // still filling with the narration that proved otherwise.
      //
      // Letting narration reset the clock was tried and reverted once, because
      // subagent chatter kept runs alive until the total cap. Two things have
      // changed: subagents are off, so this stream now carries one line per
      // real tool call, and there are two hard ceilings above it — the exec
      // total cap here, and the review's own wall-clock deadline. A stuck
      // agent still dies; a working one no longer does.
      touch();
      if (input.onLog) {
        stderrLine += chunk;
        const parts = stderrLine.split(/\r?\n/);
        stderrLine = parts.pop() ?? "";
        for (const line of parts) {
          const trimmed = line.trim();
          if (trimmed.length > 0) input.onLog(trimmed);
        }
      }
      // Bound diagnostics so a noisy failed CLI cannot inflate the action log/error.
      if (stderr.length < 4_000) stderr += chunk;
    });
    child.on("error", (cause) => {
      finish(() => reject(new RetryableProviderError(`CLI failed to start: ${cause.message}`)));
    });
    child.on("close", (code, signal) => {
      finish(() => {
        if (code !== 0) {
          const detail = stderr.trim().slice(0, 300);
          reject(
            new ProviderRequestError(
              `CLI exited with ${signal ? `signal ${signal}` : `code ${String(code)}`}${detail ? `: ${detail}` : ""}`,
            ),
          );
          return;
        }
        const content = stdout.trim();
        if (content.length === 0) {
          reject(new ProviderRequestError("CLI exited successfully but produced no completion"));
          return;
        }
        resolve({ content, usage: EMPTY_USAGE });
      });
    });
    child.stdin.on("error", (cause) => {
      finish(() => reject(new RetryableProviderError(`CLI stdin failed: ${cause.message}`)));
    });
    child.stdin.end(`${input.systemPrompt}\n\n${input.userPrompt}`);
  });
}
