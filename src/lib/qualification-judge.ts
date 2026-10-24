/**
 * The qualification checks' judgments, asked of the fleet's typed-judgment vendor (Jev) through
 * chat-service `POST /orgs/judgments`, billed to the org whose request asked (chat-service
 * declares the spend). Two shapes: a yes/no probability (`noul`) and a pick among options
 * (`choice`), over text or over an IMAGE (`judgeImageYesNo`, a screenshot check's own question asked of the screenshot).
 * The answer is frozen with the model RELEASE the vendor reports serving.
 */
import { CHAT_SERVICE_API_KEY, CHAT_SERVICE_URL } from "../config.js";
import { paymentRefusal } from "./credit-errors.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { RunSupport } from "./run-tasks.js";
import { identityHeaders, type SpendIdentity } from "./treg-client.js";

const TIMEOUT_MS = 60_000;

/** Jev's limit is 32k tokens of state; ~4 chars a token, with room for the question. */
export const MAX_STATE_CHARS = 100_000;

/**
 * WHO pays: the org whose request asked (its identity headers, `/orgs/judgments`), or the PLATFORM for a
 * background sweep no org request started (`/internal/platform-judgments`: service key only, no org or user).
 * A platform call states WHOSE WORK it is (PLATFORM-CALLER-RUN-1024, chat-service's contract): the run of THIS
 * service doing the work (`x-run-id`: chat-service's platform run becomes its child, the spend rides that run's
 * outcome), or, only when no run stands behind the call by design, the support function it serves (body `support`).
 * Never both, never neither; never a run id another service opened (an inbound request's run is not ours).
 */
export type PlatformCaller = { runId: string } | { support: RunSupport };
export type JudgmentPayer = SpendIdentity | { platform: PlatformCaller };

/** The wire half of a platform caller: its run as `x-run-id`, or its support function in the body. */
export function platformCallerWire(caller: PlatformCaller): { headers: Record<string, string>; body: { support?: RunSupport } } {
  if ("runId" in caller) {
    if (!caller.runId) throw new Error("[lead-service] platform judgment: a caller run must be a run id");
    return { headers: { "x-run-id": caller.runId }, body: {} };
  }
  return { headers: {}, body: { support: caller.support } };
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The state with every half of a split emoji replaced by U+FFFD. A text cut at N UTF-16 units (a message head, a
 * truncated field) can end on half a surrogate pair; the model vendor refuses the whole request as
 * "invalid Unicode text" (400, not retryable), and the relationship sweep asked the same pairs again every tick.
 */
export function wellFormedState(value: unknown): unknown {
  if (typeof value === "string") return value.replace(LONE_SURROGATE, "\uFFFD");
  if (Array.isArray(value)) return value.map(wellFormedState);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [wellFormedState(k) as string, wellFormedState(v)]));
  }
  return value;
}

/** The typed judges chat-service offers for a judgment (its `judge` field). */
export const IMAGE_JUDGES = ["jev", "openai-luna", "cloudflare-clef", "cloudflare-clef-flash"] as const;
export type ImageJudge = (typeof IMAGE_JUDGES)[number];

/**
 * The judge that answers screenshot checks, picked on the benchmark of every stored screenshot x every criterion that
 * used it, accuracy first, cost second (IMAGE-JUDGE-CLEF-1021, 2026-10-21: 111 checks, 72 screenshots, 3 criteria; the
 * 42 disagreements checked by eye, 6 too ambiguous to score). Right on 105 scored: jev 105 ($0.00035 a check), cloudflare-clef
 * 103 ($0.00065), openai-luna 94 ($0.00037, read clean pages as outdated), cloudflare-clef-flash 79 ($0.00010, answered
 * "CTA absent" yes on 23 pages showing one and missed both cookie walls). All four got the phone-in-header question 33/33.
 */
export const SCREENSHOT_JUDGE: ImageJudge = "jev";

/** The input-token cost name chat-service declares a judgment under, per judge (output is free at every judge). */
export const JUDGE_INPUT_COST_NAMES: Record<ImageJudge, string> = {
  jev: "typesafe-jev-1.13-tokens-input",
  "openai-luna": "openai-gpt-6-luna-decisions-tokens-input",
  "cloudflare-clef": "cloudflare-clef-tokens-input",
  "cloudflare-clef-flash": "cloudflare-clef-flash-tokens-input",
};

/** Input tokens one screenshot judgment costs at SCREENSHOT_JUDGE (image + questions): 4,117 on average over the 111 stored screenshot checks of the benchmark. */
export const IMAGE_JUDGE_INPUT_TOKENS = 4_100;

async function ask(
  state: unknown,
  questions: Record<string, Record<string, unknown>>,
  id: JudgmentPayer,
  extra: { imageUrl?: string; judge?: ImageJudge } = {},
): Promise<{ answers: Record<string, Record<string, unknown>>; model: string }> {
  const platform = "platform" in id ? platformCallerWire(id.platform) : null;
  const path = platform ? "/internal/platform-judgments" : "/orgs/judgments";
  const res = await fetchWithRetry(`${CHAT_SERVICE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": CHAT_SERVICE_API_KEY, ...(platform ? platform.headers : identityHeaders(id as SpendIdentity)) },
    body: JSON.stringify({
      ...(platform ? platform.body : {}),
      state: wellFormedState(state),
      questions,
      ...(extra.imageUrl ? { image: { url: extra.imageUrl } } : {}),
      ...(extra.judge ? { judge: extra.judge } : {}),
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text();
    const refusal = paymentRefusal(res.status, text);
    if (refusal) throw refusal;
    throw new Error(`[lead-service] chat-service judgment failed: ${res.status} ${text.slice(0, 300)}`);
  }
  const body = (await res.json()) as { model?: unknown; answers?: Record<string, unknown> };
  if (typeof body.model !== "string" || !body.model) throw new Error("[lead-service] chat-service judgment answered without its model release");
  const answers: Record<string, Record<string, unknown>> = {};
  for (const key of Object.keys(questions)) {
    const a = body.answers?.[key];
    if (!a || typeof a !== "object") throw new Error(`[lead-service] chat-service judgment answered without "${key}"`);
    answers[key] = a as Record<string, unknown>;
  }
  return { answers, model: body.model };
}

export interface YesNoQuestion {
  instructions: string;
  /** What yes and no mean, when the question alone leaves the boundary open. */
  whenTrue?: string;
  whenFalse?: string;
}

/** Several yes/no questions about ONE state, in one call. Each answer is a yes-probability. */
export async function judgeYesNo<K extends string>(
  state: unknown,
  questions: Record<K, YesNoQuestion>,
  id: JudgmentPayer,
): Promise<{ probabilities: Record<K, number>; model: string }> {
  const wire: Record<string, Record<string, unknown>> = {};
  for (const [k, q] of Object.entries(questions) as Array<[K, YesNoQuestion]>) {
    wire[k] = { type: "noul", instructions: q.instructions, ...(q.whenTrue && q.whenFalse ? { criteria: { true: q.whenTrue, false: q.whenFalse } } : {}) };
  }
  const { answers, model } = await ask(state, wire, id);
  return { probabilities: readProbabilities(answers, Object.keys(questions) as K[]), model };
}

/**
 * Several yes/no questions about ONE image (plus a small state naming whose it is), in one call to the named judge.
 * A judge that takes no `criteria` (openai-luna) gets the yes/no boundaries written into its instructions instead.
 */
export async function judgeImageYesNo<K extends string>(
  state: unknown,
  imageUrl: string,
  questions: Record<K, YesNoQuestion>,
  id: JudgmentPayer,
  judge: ImageJudge = SCREENSHOT_JUDGE,
): Promise<{ probabilities: Record<K, number>; model: string }> {
  const wire: Record<string, Record<string, unknown>> = {};
  for (const [k, q] of Object.entries(questions) as Array<[K, YesNoQuestion]>) {
    const bounded = q.whenTrue && q.whenFalse;
    wire[k] =
      judge === "openai-luna"
        ? { type: "noul", instructions: bounded ? `${q.instructions}\nYes: ${q.whenTrue}\nNo: ${q.whenFalse}` : q.instructions }
        : { type: "noul", instructions: q.instructions, ...(bounded ? { criteria: { true: q.whenTrue, false: q.whenFalse } } : {}) };
  }
  const { answers, model } = await ask(state, wire, id, { imageUrl, judge });
  return { probabilities: readProbabilities(answers, Object.keys(questions) as K[]), model };
}

function readProbabilities<K extends string>(answers: Record<string, Record<string, unknown>>, keys: K[]): Record<K, number> {
  const probabilities = {} as Record<K, number>;
  for (const k of keys) {
    const p = answers[k].noul;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`[lead-service] judgment "${k}" answered without a readable probability`);
    probabilities[k] = p;
  }
  return probabilities;
}

export async function judgeChoice(
  state: unknown,
  q: { instructions: string; options: Record<string, string> },
  id: SpendIdentity,
): Promise<{ choice: string; confidence: number; model: string }> {
  const { answers, model } = await ask(state, { answer: { type: "choice", instructions: q.instructions, criteria: q.options } }, id);
  const answer = answers.answer;
  if (typeof answer.choice !== "string" || !(answer.choice in q.options)) {
    throw new Error("[lead-service] judgment answered outside the options it was given");
  }
  return { choice: answer.choice, confidence: Number(answer.confidence ?? 0), model };
}
