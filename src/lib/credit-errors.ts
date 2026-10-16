// The empty-serve vocabulary lives in one place (serve-reasons.ts) so a caller reading
// `reason` sees a closed set, and so nothing here can drift from what the schema publishes.
import { CREDIT_INSUFFICIENT_REASON } from "./serve-reasons.js";
import { InsufficientCreditError, readFundingCap, type FundingCapRefusal } from "./treg-client.js";

export { CREDIT_INSUFFICIENT_REASON };
export { fundingCapLabel, readFundingCap, SALES_FUNNEL_CAP_REASONS, type FundingCapRefusal, type FundingCapReason } from "./treg-client.js";

export type CreditInsufficientReason = typeof CREDIT_INSUFFICIENT_REASON;

function hasCreditInsufficientShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const body = value as { type?: unknown; error?: unknown };
  // A sales-funnel MAX BUDGET refusal is a stop like a balance refusal (no retry storm), whatever
  // wording the sibling chose for `error` (FUNNEL-CAP-NAMED-402-1016).
  return body.type === CREDIT_INSUFFICIENT_REASON || body.error === "Insufficient credits" || readFundingCap(value) !== null;
}

export function isCreditInsufficientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  // A qualification probe the org's balance cannot cover (src/lib/treg-client.ts).
  if ((error as { name?: unknown }).name === "InsufficientCreditError") return true;

  const maybeStructured = error as {
    status?: unknown;
    body?: unknown;
    responseBody?: unknown;
    message?: unknown;
  };

  if (maybeStructured.status === 402 && hasCreditInsufficientShape(maybeStructured.body)) {
    return true;
  }
  if (maybeStructured.status === 402 && hasCreditInsufficientShape(maybeStructured.responseBody)) {
    return true;
  }

  if (typeof maybeStructured.message !== "string") return false;
  const message = maybeStructured.message;
  return (
    message.includes("402") &&
    (message.includes(CREDIT_INSUFFICIENT_REASON) || message.includes("Insufficient credits") || readFundingCap(message) !== null)
  );
}

/**
 * The funnel-cap cause behind a credit refusal recognised by `isCreditInsufficientError`, read from
 * our own `InsufficientCreditError` or from the sibling's relayed body/message. Null = a real balance
 * shortfall (or a cause nobody stated): today's `credit_insufficient` answer stands.
 */
export function fundingCapOf(error: unknown): FundingCapRefusal | null {
  if (!error || typeof error !== "object") return null;
  if (error instanceof InsufficientCreditError) return error.fundingCap;
  const e = error as { name?: unknown; fundingCap?: unknown; body?: unknown; responseBody?: unknown; responseText?: unknown; message?: unknown };
  if (e.name === "InsufficientCreditError") return readFundingCap(e.fundingCap);
  return readFundingCap(e.body) ?? readFundingCap(e.responseBody) ?? readFundingCap(e.responseText) ?? readFundingCap(e.message);
}

/** chat-service states cents as decimal STRINGS (`"-1.2800000000"`); billing as numbers. */
function centsOrNull(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * A sibling that owns a spend answers 402 when the org cannot pay (the fleet's insufficient-credit
 * status). That refusal is the CALLER's payment problem, not a sibling failure: it becomes an
 * `InsufficientCreditError` so the route answers 402, never 502. Null for any other status.
 */
export function paymentRefusal(status: number, text: string): InsufficientCreditError | null {
  if (status !== 402) return null;
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as Record<string, unknown>;
  } catch {
    // A 402 whose body is not JSON is still a refusal for lack of money; only the figures are unknown.
  }
  return new InsufficientCreditError(
    centsOrNull(body.balance_cents ?? body.balanceCents),
    centsOrNull(body.required_cents ?? body.requiredCents),
    // A sibling relaying billing's funnel-cap refusal keeps its cause (`reason` + `sales_funnel_cap`).
    readFundingCap(Object.keys(body).length > 0 ? body : text),
  );
}
