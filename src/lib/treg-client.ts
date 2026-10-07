/**
 * One METERED call to a treg catalogue endpoint, on behalf of an org.
 *
 * treg (https://treg.to) relays thousands of priced data endpoints under one token and states the
 * exact charge of every call in `X-Treg-Cost-Micro` (integer micro-USD). The fleet declares all of
 * them under ONE cost name, `treg-micro-usd` (costs-service seed), quantity = that integer.
 *
 * The spend follows the fleet's order, fail loud:
 *   PROVISION the call's ceiling on the run -> AUTHORIZE it with billing-service (platform key only;
 *   an org's own treg key is theirs) -> EXECUTE with `X-Treg-Route-Max-Cost` = the same ceiling,
 *   so treg refuses (402, unbilled) rather than overspend -> post the real charge as `actual` ->
 *   CANCEL the hold.
 *
 * A call that never answered (network error, timeout) leaves its hold OPEN on purpose: treg may
 * have charged, and only a reconciler that can ask treg should close it. Same rule as
 * apollo-service's linkedin-engagement meter, which this mirrors.
 */
import { randomUUID } from "node:crypto";
import {
  BILLING_SERVICE_API_KEY,
  BILLING_SERVICE_URL,
  KEY_SERVICE_API_KEY,
  KEY_SERVICE_URL,
  RUNS_SERVICE_API_KEY,
  RUNS_SERVICE_URL,
  TREG_BASE_URL,
} from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { ParamValue } from "./qualification-probes.js";

export const TREG_COST_NAME = "treg-micro-usd";
const CALL_TIMEOUT_MS = 90_000;
const SIBLING_TIMEOUT_MS = 30_000;

/** The org request the spend is billed to (its identity headers). */
export interface SpendIdentity {
  orgId: string;
  userId: string;
  /** The run the costs hang on. */
  runId: string;
  brandId?: string | null;
  campaignId?: string | null;
  workflowSlug?: string | null;
  featureSlug?: string | null;
}

export function identityHeaders(id: SpendIdentity): Record<string, string> {
  const h: Record<string, string> = { "x-org-id": id.orgId, "x-user-id": id.userId, "x-run-id": id.runId };
  if (id.brandId) h["x-brand-id"] = id.brandId;
  if (id.campaignId) h["x-campaign-id"] = id.campaignId;
  if (id.workflowSlug) h["x-workflow-slug"] = id.workflowSlug;
  if (id.featureSlug) h["x-feature-slug"] = id.featureSlug;
  return h;
}

export class InsufficientCreditError extends Error {
  constructor(public readonly balanceCents: number, public readonly requiredCents: number) {
    super(`insufficient credit: balance ${balanceCents}c, required ${requiredCents}c`);
    this.name = "InsufficientCreditError";
  }
}

/** treg's own refusal (tool withdrawn, our ceiling, out of balance), as opposed to the provider's answer. */
export class TregRefusedError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "TregRefusedError";
  }
}

interface TregKeys {
  token: string;
  org: string;
  keySource: "org" | "platform";
}

async function decrypt(provider: string, id: SpendIdentity): Promise<{ key: string; keySource: "org" | "platform" }> {
  const res = await fetchWithRetry(`${KEY_SERVICE_URL}/keys/${provider}/decrypt`, {
    method: "GET",
    headers: {
      "X-API-Key": KEY_SERVICE_API_KEY,
      "X-Caller-Service": "lead",
      "X-Caller-Method": "POST",
      "X-Caller-Path": "/orgs/brands/:brandId/qualification",
      "x-org-id": id.orgId,
      "x-user-id": id.userId,
      "x-run-id": id.runId,
    },
    signal: AbortSignal.timeout(SIBLING_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[lead-service] key-service ${provider} decrypt failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { key?: unknown; keySource?: unknown };
  if (typeof body.key !== "string" || (body.keySource !== "org" && body.keySource !== "platform")) {
    throw new Error(`[lead-service] key-service ${provider} decrypt answered without a key/keySource`);
  }
  return { key: body.key, keySource: body.keySource };
}

async function resolveKeys(id: SpendIdentity): Promise<TregKeys> {
  const [token, org] = await Promise.all([decrypt("treg", id), decrypt("treg-org", id)]);
  return { token: token.key, org: org.key, keySource: token.keySource };
}

interface RunCost {
  id: string;
}

async function runsCosts(
  id: SpendIdentity,
  items: Array<{ costName: string; costSource: "org" | "platform"; quantity: number; status?: "provisioned" | "actual" }>,
): Promise<RunCost[]> {
  const res = await fetchWithRetry(`${RUNS_SERVICE_URL}/v1/runs/${id.runId}/costs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": RUNS_SERVICE_API_KEY, ...identityHeaders(id) },
    body: JSON.stringify({ items: items.map((i) => ({ ...i, idempotencyKey: `lead-service:cost:${randomUUID()}` })) }),
    signal: AbortSignal.timeout(SIBLING_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[lead-service] runs-service POST costs failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { costs?: RunCost[] };
  return body.costs ?? [];
}

async function cancelCost(id: SpendIdentity, costId: string): Promise<void> {
  const res = await fetchWithRetry(`${RUNS_SERVICE_URL}/v1/runs/${id.runId}/costs/${costId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-API-Key": RUNS_SERVICE_API_KEY, ...identityHeaders(id) },
    body: JSON.stringify({ status: "cancelled" }),
    signal: AbortSignal.timeout(SIBLING_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[lead-service] runs-service cancel cost ${costId} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function authorize(id: SpendIdentity, maxMicro: number, description: string): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "X-API-Key": BILLING_SERVICE_API_KEY, ...identityHeaders(id) };
  const res = await fetchWithRetry(`${BILLING_SERVICE_URL}/v1/customer_balance/authorize`, {
    method: "POST",
    headers,
    body: JSON.stringify({ items: [{ costName: TREG_COST_NAME, quantity: maxMicro }], description }),
    signal: AbortSignal.timeout(SIBLING_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[lead-service] billing-service authorize failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { sufficient?: unknown; balance_cents?: number; required_cents?: number };
  if (body.sufficient !== true) throw new InsufficientCreditError(Number(body.balance_cents ?? 0), Number(body.required_cents ?? 0));
}

export interface TregCallResult {
  status: number;
  body: unknown;
  /** What treg charged, micro-USD. 0 on a free failure. */
  chargedMicro: number;
  /** The content type the provider answered with. */
  contentType: string | null;
}

/**
 * Keys are resolved once per meter (one qualification run), never per call.
 */
export class TregMeter {
  private keys: Promise<TregKeys> | null = null;

  constructor(private readonly identity: SpendIdentity) {}

  private resolve(): Promise<TregKeys> {
    if (!this.keys) this.keys = resolveKeys(this.identity);
    return this.keys;
  }

  async call(req: { endpointId: string; method: "GET" | "POST"; params: Record<string, ParamValue>; maxMicro: number }): Promise<TregCallResult> {
    const keys = await this.resolve();
    const [hold] = await runsCosts(this.identity, [
      { costName: TREG_COST_NAME, costSource: keys.keySource, quantity: req.maxMicro, status: "provisioned" },
    ]);
    if (!hold?.id) throw new Error(`[lead-service] runs-service returned no cost id for the ${TREG_COST_NAME} hold`);

    if (keys.keySource === "platform") {
      try {
        await authorize(this.identity, req.maxMicro, `qualification probe: ${req.endpointId}`);
      } catch (error) {
        await cancelCost(this.identity, hold.id);
        throw error;
      }
    }

    let url = `${TREG_BASE_URL}/call/${req.endpointId}`;
    const headers: Record<string, string> = {
      "X-Treg-Token": keys.token,
      "X-Treg-Org": keys.org,
      "X-Treg-Route-Max-Cost": (req.maxMicro / 1_000_000).toFixed(6),
      "Idempotency-Key": randomUUID(),
    };
    let body: string | undefined;
    if (req.method === "GET") {
      const qs = new URLSearchParams(Object.entries(req.params).map(([k, v]) => [k, String(v)]));
      url += `?${qs.toString()}`;
    } else {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(req.params);
    }

    // No retry: a call that reached treg may have been charged. A throw here leaves the hold open.
    const response = await fetch(url, { method: req.method, headers, body, signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    const contentType = response.headers.get("content-type");
    const text = await response.text();
    let parsed: unknown = text;
    if (contentType?.includes("json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    const costHeader = response.headers.get("x-treg-cost-micro");
    let charged = 0;
    if (costHeader !== null) {
      charged = Number(costHeader);
      if (!Number.isFinite(charged) || charged < 0) throw new Error(`[lead-service] treg cost header unreadable: ${costHeader}`);
    } else if (response.ok) {
      // A 2xx without its charge cannot be declared: refuse to pretend it was free. Hold stays open.
      throw new Error(`[lead-service] treg ${req.endpointId} answered ${response.status} without X-Treg-Cost-Micro; cannot declare the cost`);
    }
    if (charged > 0) {
      await runsCosts(this.identity, [{ costName: TREG_COST_NAME, costSource: keys.keySource, quantity: charged }]);
    }
    await cancelCost(this.identity, hold.id);
    if (charged > req.maxMicro) {
      console.error(`[lead-service] treg ${req.endpointId} charged ${charged} micro-USD above its ${req.maxMicro} ceiling`);
    }
    return { status: response.status, body: parsed, chargedMicro: charged, contentType };
  }
}

/** treg's OWN refusal (no tool, our ceiling, balance), never the provider's answer. */
export function isTregRefusal(status: number, body: unknown): boolean {
  if (status === 402) return true;
  const detail = typeof body === "object" && body ? String((body as Record<string, unknown>).detail ?? (body as Record<string, unknown>).error ?? "") : "";
  return (status === 404 || status === 410 || status === 403) && /no tool|not available|disabled|withdrawn/i.test(detail);
}
