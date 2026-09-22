import { randomBytes } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

// Confidence tiers grounded in CDP identity-resolution canon (Segment / RudderStack /
// Hightouch / Amperity): deterministic (a shared unique id like email/phone), strong
// (a high-signal combination), probabilistic (name-only, inherently ambiguous).
export type MatchConfidence = "deterministic" | "strong" | "probabilistic" | "unmatched";
export type MatchMethod = "email" | "phone" | "domain_name" | "full_name" | "last_name" | null;
export type AttributionStatus = "attributed" | "needs_review" | "unmatched";
export type ConversionEventName = "signup" | "meeting_booked" | "form_submission" | "sale";

export const CONVERSION_EVENTS: readonly ConversionEventName[] = [
  "signup",
  "meeting_booked",
  "form_submission",
  "sale",
];

// Legacy conversion-event spellings accepted on ingest for backward compatibility, each
// mapped to its canonical name. "purchase" was renamed to "sale" (the terminal "a customer
// paid" signal, which carries a revenue value); already-configured client integrations still
// fire "purchase", so ingest keeps accepting it and normalizes it to "sale" BEFORE dedupe +
// storage — every stored row and every read path is canonical "sale".
const LEGACY_EVENT_ALIASES: Readonly<Record<string, ConversionEventName>> = {
  purchase: "sale",
};

export function isConversionEvent(value: unknown): value is ConversionEventName {
  return typeof value === "string" && (CONVERSION_EVENTS as readonly string[]).includes(value);
}

/**
 * Canonicalize a raw event string to its stored form — the single acceptance gate for a
 * REAL conversion event on BOTH the write path (ingest normalizes the incoming spelling)
 * and the read path (folds a legacy-spelled historical row into its canonical bucket):
 *   - a canonical event ("signup" | "meeting_booked" | "form_submission" | "sale") → itself
 *   - a legacy alias ("purchase") → its canonical name ("sale")
 *   - anything else (incl. "ping", garbage, non-string) → null
 */
export function canonicalizeConversionEvent(value: unknown): ConversionEventName | null {
  if (typeof value !== "string") return null;
  if ((CONVERSION_EVENTS as readonly string[]).includes(value)) {
    return value as ConversionEventName;
  }
  return LEGACY_EVENT_ALIASES[value] ?? null;
}

// A liveness heartbeat the client's on-page tag fires on page-load. NOT a conversion:
// it never runs attribution, never lands in conversion_events, never counts toward
// eventTypesSeen or dedupe. It only stamps last_ping_at so the dashboard can derive
// "the tracker is alive" before any real conversion arrives.
export const PING_EVENT = "ping" as const;

export function isPingEvent(value: unknown): value is typeof PING_EVENT {
  return value === PING_EVENT;
}

// Consumer-observable liveness, derived (never self-attested):
//   not_set_up   — nothing received yet (no ping, no real conversion)
//   live_waiting — a ping proves the tag is alive, but no real conversion yet
//   live         — at least one real conversion received
export type ConversionTrackerStatus = "not_set_up" | "live_waiting" | "live";

export function deriveConversionStatus(params: {
  hasRealEvent: boolean;
  hasPing: boolean;
}): ConversionTrackerStatus {
  if (params.hasRealEvent) return "live";
  if (params.hasPing) return "live_waiting";
  return "not_set_up";
}

/** Generate a publishable write-key. Not a secret (embedded in a client-side pixel). */
export function generateConversionToken(): string {
  return `pk_conv_${randomBytes(24).toString("base64url")}`;
}

/** Lowercase + trim. Email exact match is case-insensitive. */
export function normalizeEmail(email: string | undefined | null): string | null {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

/** Strip everything but digits. Two phones match iff their digit strings are equal. */
export function normalizePhone(phone: string | undefined | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length > 0 ? digits : null;
}

/**
 * Derive the bare registrable host from a company URL: strip protocol, path, port,
 * and a leading "www.". "https://www.Acme.com/careers" → "acme.com". Returns null
 * when nothing usable can be parsed.
 */
export function deriveDomain(companyUrl: string | undefined | null): string | null {
  if (!companyUrl) return null;
  let raw = companyUrl.trim().toLowerCase();
  if (raw.length === 0) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) raw = `https://${raw}`;
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return null;
  }
  host = host.replace(/^www\./, "");
  return host.length > 0 ? host : null;
}

/**
 * Effective dedupe signature. If the client supplied a dedupeKey, uniqueness is per
 * (brandId, dedupeKey). Otherwise per (brandId, event, email-or-phone, calendar-day).
 * When there is no dedupe basis at all (no dedupeKey, no email, no phone), returns null
 * → the caller inserts unconditionally (no dedupe possible).
 */
export function computeDedupeSignature(params: {
  dedupeKey?: string | null;
  event: ConversionEventName;
  email?: string | null;
  phone?: string | null;
  now: Date;
}): string | null {
  const dedupeKey = params.dedupeKey?.trim();
  if (dedupeKey) return `k:${dedupeKey}`;

  const identity = normalizeEmail(params.email) ?? normalizePhone(params.phone);
  if (!identity) return null;

  const day = params.now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC calendar day)
  return `a:${params.event}:${identity}:${day}`;
}

/**
 * Resolve the attribution status from the confidence tier and candidate count.
 * Product decision: a name is enough — name-only (probabilistic) matches auto-attribute
 * to the top candidate (the candidate set is already ordered most-engaged then recency).
 * The only tier still held for review is the strong-ambiguous case (domain+lastName with
 * >1 candidate), where two distinct people share a last name at the same company.
 */
export function resolveAttributionStatus(
  confidence: MatchConfidence,
  candidateCount: number,
): AttributionStatus {
  switch (confidence) {
    case "deterministic":
      // email/phone: a shared unique id. Attribute even with >1 candidate
      // (tie-broken to the most-engaged); still deterministic.
      return "attributed";
    case "strong":
      // domain + lastname: single candidate → attribute; ambiguous → review.
      return candidateCount === 1 ? "attributed" : "needs_review";
    case "probabilistic":
      // name-only: attribute to the top (most-engaged) candidate, regardless of count.
      return "attributed";
    case "unmatched":
      return "unmatched";
  }
}

// A candidate lead surfaced by a match tier, ordered by engagement then recency so
// the caller can pick the winner and count ambiguity.
export interface MatchCandidate {
  leadId: string;
}

export interface MatchResult {
  matchedLeadId: string | null;
  matchMethod: MatchMethod;
  matchConfidence: MatchConfidence;
  attributionStatus: AttributionStatus;
  candidateCount: number;
  /**
   * Every candidate the winning tier surfaced, in the tier's own order (most-engaged first) —
   * `matchedLeadId` is `candidates[0]`. Carried so a caller that must NAME the alternatives can
   * do so without re-running the waterfall: the CRM pairing surface asks a similarity judgment
   * about a specific candidate, and a second matcher to enumerate them would be two answers to
   * one question. Empty when nothing matched. The conversion ingest path ignores it.
   */
  candidates: MatchCandidate[];
}

export interface WaterfallInput {
  brandId: string;
  email?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyUrl?: string | null;
}

// Each tier's engagement tie-break ranks a lead by the most-advanced delivery signal
// email-gateway would report (replied > clicked > opened > delivered > sent). That
// evidence lives in email-gateway, not lead-service; keeping ingest DB-only, we
// tie-break on the lead's most-advanced served lifecycle then most-recent serve — a
// deterministic, local proxy. Candidate scope is served leads_campaigns for the brand
// (lead-service's local "we contacted them for this brand" proof), which collapses the
// search space so name matching isn't catastrophic.
const TIER_ORDER_BY = sql`MAX(lc.served_at) DESC NULLS LAST, lc.lead_id ASC`;

async function runTier(query: ReturnType<typeof sql>): Promise<MatchCandidate[]> {
  const rows = (await db.execute(query)) as unknown as Array<{ lead_id: string }>;
  return rows.map((r) => ({ leadId: r.lead_id }));
}

function servedForBrand(brandId: string) {
  return sql`lc.status = 'served' AND ${brandId} = ANY(lc.brand_ids)`;
}

/**
 * Evaluate the match waterfall against the candidate set (served leads for this brand).
 * Tiers are evaluated in order; the first tier that yields ≥1 candidate wins.
 *   1. email exact (ci)              → deterministic / email
 *   2. phone exact (normalized)      → deterministic / phone
 *   3. company domain + lastName(ci) → strong / domain_name
 *   4. firstName + lastName (ci)     → probabilistic / full_name
 *   5. lastName only (ci)            → probabilistic / last_name
 *   6. none                          → unmatched
 */
export async function matchConversion(input: WaterfallInput): Promise<MatchResult> {
  const { brandId } = input;
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const domain = deriveDomain(input.companyUrl);
  const firstName = input.firstName?.trim();
  const lastName = input.lastName?.trim();

  const tiers: Array<{
    method: Exclude<MatchMethod, null>;
    confidence: MatchConfidence;
    candidates: () => Promise<MatchCandidate[]>;
    enabled: boolean;
  }> = [
    {
      method: "email",
      confidence: "deterministic",
      enabled: !!email,
      candidates: () =>
        runTier(sql`
          SELECT lc.lead_id
          FROM leads_campaigns lc
          JOIN lead_contact_methods cm
            ON cm.lead_id = lc.lead_id
           AND cm.channel = 'email'
           AND lower(cm.value) = ${email}
          WHERE ${servedForBrand(brandId)}
          GROUP BY lc.lead_id
          ORDER BY ${TIER_ORDER_BY}
        `),
    },
    {
      method: "phone",
      confidence: "deterministic",
      enabled: !!phone,
      candidates: () =>
        runTier(sql`
          SELECT lc.lead_id
          FROM leads_campaigns lc
          JOIN lead_contact_methods cm
            ON cm.lead_id = lc.lead_id
           AND cm.channel = 'phone'
           AND regexp_replace(cm.value, '\\D', '', 'g') = ${phone}
          WHERE ${servedForBrand(brandId)}
          GROUP BY lc.lead_id
          ORDER BY ${TIER_ORDER_BY}
        `),
    },
    {
      method: "domain_name",
      confidence: "strong",
      enabled: !!domain && !!lastName,
      candidates: () =>
        runTier(sql`
          SELECT lc.lead_id
          FROM leads_campaigns lc
          JOIN leads l ON l.id = lc.lead_id AND lower(l.last_name) = lower(${lastName})
          JOIN leads_organizations lo ON lo.lead_id = lc.lead_id
          JOIN organizations o
            ON o.id = lo.organization_id
           AND lower(o.primary_domain) = ${domain}
          WHERE ${servedForBrand(brandId)}
          GROUP BY lc.lead_id
          ORDER BY ${TIER_ORDER_BY}
        `),
    },
    {
      method: "full_name",
      confidence: "probabilistic",
      enabled: !!firstName && !!lastName,
      candidates: () =>
        runTier(sql`
          SELECT lc.lead_id
          FROM leads_campaigns lc
          JOIN leads l
            ON l.id = lc.lead_id
           AND lower(l.first_name) = lower(${firstName})
           AND lower(l.last_name) = lower(${lastName})
          WHERE ${servedForBrand(brandId)}
          GROUP BY lc.lead_id
          ORDER BY ${TIER_ORDER_BY}
        `),
    },
    {
      method: "last_name",
      confidence: "probabilistic",
      enabled: !!lastName,
      candidates: () =>
        runTier(sql`
          SELECT lc.lead_id
          FROM leads_campaigns lc
          JOIN leads l ON l.id = lc.lead_id AND lower(l.last_name) = lower(${lastName})
          WHERE ${servedForBrand(brandId)}
          GROUP BY lc.lead_id
          ORDER BY ${TIER_ORDER_BY}
        `),
    },
  ];

  for (const tier of tiers) {
    if (!tier.enabled) continue;
    const candidates = await tier.candidates();
    if (candidates.length === 0) continue;

    return {
      matchedLeadId: candidates[0].leadId, // top = most-engaged (tie-break) candidate
      matchMethod: tier.method,
      matchConfidence: tier.confidence,
      attributionStatus: resolveAttributionStatus(tier.confidence, candidates.length),
      candidateCount: candidates.length,
      candidates,
    };
  }

  return {
    matchedLeadId: null,
    matchMethod: null,
    matchConfidence: "unmatched",
    attributionStatus: "unmatched",
    candidateCount: 0,
    candidates: [],
  };
}
