// The empty-serve vocabulary lives in one place (serve-reasons.ts) so a caller reading
// `reason` sees a closed set, and so nothing here can drift from what the schema publishes.
import { CREDIT_INSUFFICIENT_REASON } from "./serve-reasons.js";
import { InsufficientCreditError } from "./treg-client.js";

export { CREDIT_INSUFFICIENT_REASON };

export type CreditInsufficientReason = typeof CREDIT_INSUFFICIENT_REASON;

function hasCreditInsufficientShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const body = value as { type?: unknown; error?: unknown };
  return body.type === CREDIT_INSUFFICIENT_REASON || body.error === "Insufficient credits";
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
    (message.includes(CREDIT_INSUFFICIENT_REASON) || message.includes("Insufficient credits"))
  );
}

function centsOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
  );
}
