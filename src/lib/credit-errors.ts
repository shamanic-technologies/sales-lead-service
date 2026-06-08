export const CREDIT_INSUFFICIENT_REASON = "credit_insufficient" as const;

export type CreditInsufficientReason = typeof CREDIT_INSUFFICIENT_REASON;

function hasCreditInsufficientShape(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const body = value as { type?: unknown; error?: unknown };
  return body.type === CREDIT_INSUFFICIENT_REASON || body.error === "Insufficient credits";
}

export function isCreditInsufficientError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

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
