/**
 * The qualification checks' judgments, asked of the fleet's typed-judgment vendor (Jev) through
 * chat-service `POST /orgs/judgments`, billed to the org whose request asked (chat-service
 * declares the spend). Two shapes: a yes/no probability (`noul`) and a pick among options
 * (`choice`). The answer is frozen with the model RELEASE the vendor reports serving.
 */
import { CHAT_SERVICE_API_KEY, CHAT_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { identityHeaders, type SpendIdentity } from "./treg-client.js";

const TIMEOUT_MS = 60_000;

/** Jev's limit is 32k tokens of state; ~4 chars a token, with room for the question. */
export const MAX_STATE_CHARS = 100_000;

async function ask(
  state: unknown,
  questions: Record<string, Record<string, unknown>>,
  id: SpendIdentity,
): Promise<{ answers: Record<string, Record<string, unknown>>; model: string }> {
  const res = await fetchWithRetry(`${CHAT_SERVICE_URL}/orgs/judgments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": CHAT_SERVICE_API_KEY, ...identityHeaders(id) },
    body: JSON.stringify({ state, questions }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[lead-service] chat-service judgment failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
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
  whenTrue: string;
  whenFalse: string;
}

/** Several yes/no questions about ONE state, in one call. Each answer is a yes-probability. */
export async function judgeYesNo<K extends string>(
  state: unknown,
  questions: Record<K, YesNoQuestion>,
  id: SpendIdentity,
): Promise<{ probabilities: Record<K, number>; model: string }> {
  const wire: Record<string, Record<string, unknown>> = {};
  for (const [k, q] of Object.entries(questions) as Array<[K, YesNoQuestion]>) {
    wire[k] = { type: "noul", instructions: q.instructions, criteria: { true: q.whenTrue, false: q.whenFalse } };
  }
  const { answers, model } = await ask(state, wire, id);
  const probabilities = {} as Record<K, number>;
  for (const k of Object.keys(questions) as K[]) {
    const p = answers[k].noul;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`[lead-service] judgment "${k}" answered without a readable probability`);
    probabilities[k] = p;
  }
  return { probabilities, model };
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
