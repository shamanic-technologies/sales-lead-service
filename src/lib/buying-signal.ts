/**
 * The buying signal a served person's audience matched — the company is hiring,
 * the person just changed jobs, the company just raised, the person engaged with
 * a competitor's LinkedIn post — as human-service
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
export const BUYING_SIGNAL_TYPES = ["hiring", "job_change", "funding", "linkedin_engagement"] as const;
export type BuyingSignalType = (typeof BUYING_SIGNAL_TYPES)[number];

export const ENGAGEMENT_KINDS = ["reaction", "comment"] as const;

/**
 * linkedin_engagement only: which competitor post the person reacted to or
 * commented on (apollo-service `BuyingSignalEvidence.engagement`). Evidence for
 * WHO to write to, never material for the email: no message may say the person
 * engaged with a competitor.
 */
export interface BuyingSignalEngagement {
  competitorPage: string;
  postUrl: string | null;
  /** Approximate: LinkedIn gives a relative age. */
  postPublishedOn: string | null;
  kind: (typeof ENGAGEMENT_KINDS)[number];
  reactionType: string | null;
  commentText: string | null;
  commentedAt: string | null;
}

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
  /** Present only when the producer served one (linkedin_engagement). */
  engagement?: BuyingSignalEngagement;
}

const isNullableString = (v: unknown) => v === null || typeof v === "string";

function isEngagement(raw: unknown): raw is BuyingSignalEngagement {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const e = raw as Record<string, unknown>;
  return (
    typeof e.competitorPage === "string" &&
    isNullableString(e.postUrl) &&
    isNullableString(e.postPublishedOn) &&
    (ENGAGEMENT_KINDS as readonly unknown[]).includes(e.kind) &&
    isNullableString(e.reactionType) &&
    isNullableString(e.commentText) &&
    isNullableString(e.commentedAt)
  );
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
    !(r.sourceUrl === null || r.sourceUrl === undefined || typeof r.sourceUrl === "string") ||
    !(r.engagement === undefined || isEngagement(r.engagement))
  ) {
    throw new Error(
      `[lead-service] served person carried a malformed buyingSignal: ${JSON.stringify(raw).slice(0, 300)}`,
    );
  }
  const signal: BuyingSignal = {
    type: r.type as BuyingSignalType,
    occurredOn: r.occurredOn,
    fact: r.fact,
    source: r.source,
    sourceUrl: (r.sourceUrl as string | null | undefined) ?? null,
  };
  if (r.engagement !== undefined) {
    const e = r.engagement as BuyingSignalEngagement;
    signal.engagement = {
      competitorPage: e.competitorPage,
      postUrl: e.postUrl,
      postPublishedOn: e.postPublishedOn,
      kind: e.kind,
      reactionType: e.reactionType,
      commentText: e.commentText,
      commentedAt: e.commentedAt,
    };
  }
  return signal;
}
