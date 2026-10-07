/**
 * Text writing and image reading, through chat-service `POST /complete` (it owns the model, the
 * credential and the cost declaration; this service declares no LLM cost). Classification never
 * goes here: a yes/no or a pick among options is a JUDGMENT (src/lib/qualification-judge.ts).
 *
 * Used for three writing jobs of the qualification checks: drafting the suggested criteria from a
 * brand's offer, describing a homepage screenshot in words, and stating the measured evidence in
 * one sentence. Google models: flash-lite (cheapest that reads images) unless a job asks for flash.
 */
import { CHAT_SERVICE_API_KEY, CHAT_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { identityHeaders, type SpendIdentity } from "./treg-client.js";

const TIMEOUT_MS = 120_000;

export interface CompleteRequest {
  systemPrompt: string;
  message: string;
  imageUrl?: string;
  json?: boolean;
  maxTokens?: number;
  model?: "flash-lite" | "flash";
}

export interface CompleteResult {
  content: string;
  json: Record<string, unknown> | null;
  model: string;
  tokensInput: number;
  tokensOutput: number;
}

export async function complete(req: CompleteRequest, id: SpendIdentity): Promise<CompleteResult> {
  const res = await fetchWithRetry(`${CHAT_SERVICE_URL}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": CHAT_SERVICE_API_KEY, ...identityHeaders(id) },
    body: JSON.stringify({
      provider: "google",
      model: req.model ?? "flash-lite",
      systemPrompt: req.systemPrompt,
      message: req.message,
      ...(req.imageUrl ? { imageUrl: req.imageUrl } : {}),
      ...(req.json ? { responseFormat: "json" } : {}),
      ...(req.maxTokens ? { maxTokens: req.maxTokens } : {}),
      // Thinking tokens count against maxTokens: a one-sentence job with thinking on came back cut
      // mid-word ("The", "There is no") on 5 of 12 prod leads.
      disableThinking: true,
      temperature: 0,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[lead-service] chat-service /complete failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { content?: unknown; json?: unknown; model?: unknown; tokensInput?: unknown; tokensOutput?: unknown };
  if (typeof body.content !== "string" || typeof body.model !== "string") {
    throw new Error("[lead-service] chat-service /complete answered without content/model");
  }
  const json = body.json && typeof body.json === "object" ? (body.json as Record<string, unknown>) : null;
  if (req.json && !json) throw new Error("[lead-service] chat-service /complete answered without the JSON asked for");
  return { content: body.content, json, model: body.model, tokensInput: Number(body.tokensInput ?? 0), tokensOutput: Number(body.tokensOutput ?? 0) };
}

/** Client copy never carries a long dash (fleet copy rule): strip what a model slips in. */
export function stripDashes(text: string): string {
  return text.replace(/\s*[—–]\s*/g, ", ").replace(/\s+/g, " ").trim();
}
