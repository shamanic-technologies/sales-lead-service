/**
 * The buying signal a served person's audience matched — the company is hiring,
 * the person just changed jobs, the company just raised — as human-service
 * serves it on the neutral `Person` (its `BuyingSignal` schema). apollo-service
 * produces it on the reveal; human-service carries it; this service keeps it on
 * the serve and hands it out with the lead so the email writer can reference it.
 *
 * Carried, never derived: nothing here infers a signal from an audience name, a
 * title, a funding stage or a date. Absent stays absent (`null`).
 *
 * This module must not import the database: `src/schemas.ts` (and the OpenAPI
 * generator, which runs with no database configured) reach it.
 */
export const BUYING_SIGNAL_TYPES = ["hiring", "job_change", "funding"] as const;
export type BuyingSignalType = (typeof BUYING_SIGNAL_TYPES)[number];

export interface BuyingSignal {
  type: BuyingSignalType;
  /** YYYY-MM-DD, the day the signal happened, as the provider recorded it. */
  occurredOn: string;
  /** One English sentence stating the signal, for the email writer to reference. */
  fact: string;
  /** Where the evidence came from, e.g. "apollo:job_postings". */
  source: string;
  /** The posting or news link, when the provider gave one. */
  sourceUrl: string | null;
}

/**
 * Read the signal off a served person. `undefined` / `null` (a producer that
 * serves none, or a person not served from a signal audience) is `null`.
 *
 * A PRESENT value missing a field the contract requires THROWS rather than being
 * trimmed to what parses: a half-signal handed to the email writer is a claim
 * about a prospect nobody made, and silently dropping it would hide a producer
 * contract break. Mirrors human-service's own `readBuyingSignal`.
 */
export function readBuyingSignal(raw: unknown): BuyingSignal | null {
  if (raw === undefined || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    typeof r.type !== "string" ||
    !(BUYING_SIGNAL_TYPES as readonly string[]).includes(r.type) ||
    typeof r.occurredOn !== "string" ||
    typeof r.fact !== "string" ||
    r.fact.trim() === "" ||
    typeof r.source !== "string" ||
    !(r.sourceUrl === null || r.sourceUrl === undefined || typeof r.sourceUrl === "string")
  ) {
    throw new Error(
      `[lead-service] served person carried a malformed buyingSignal: ${JSON.stringify(raw).slice(0, 300)}`,
    );
  }
  return {
    type: r.type as BuyingSignalType,
    occurredOn: r.occurredOn,
    fact: r.fact,
    source: r.source,
    sourceUrl: (r.sourceUrl as string | null | undefined) ?? null,
  };
}
