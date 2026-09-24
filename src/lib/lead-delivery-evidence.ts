/**
 * What the delivery layer last told us about an address, KEPT — so a page of the Leads page does
 * not have to ask email-gateway about a whole brand every time it is drawn.
 *
 * Every count, tab and board column on the customer's Leads page needs the delivery evidence of
 * EVERY person in scope (contacted, clicked, replied, how the reply was read, opted out). Asking
 * email-gateway for it on every read meant ~180 requests of 100 addresses each for one 17,680-person
 * brand, per read, five reads per page load, re-polled every 15 seconds per open tab — 3.4s of every
 * read, and the reason a lead marked Won took ~30s to appear. This table is that answer, stored per
 * address exactly as the gateway gave it, with the time it was asked.
 *
 * Keyed EXACTLY like the question: `(org, brand the gateway was asked for, campaign mode, email)`.
 * The brand is the row's PRIMARY brand (the list has always grouped its gateway calls that way) and
 * the campaign is `''` for a brand-mode question or the one campaign a single-campaign scope asks
 * about — a brand-mode and a campaign-mode answer are different answers and are never mixed.
 *
 * How OLD an answer may be is never decided here: every read names the oldest answer it accepts
 * (`acceptFetchedSince`) and anything older is asked again. The read model is what states and
 * enforces the bound (see lead-read-model.ts). FAIL LOUD: an address the gateway could not answer
 * for rejects the whole read; a stale or missing answer is never served as if it were current.
 */
import { sql } from "../db/index.js";
import { checkDeliveryStatus, type StatusResult } from "./email-gateway-client.js";

/** The identity headers the gateway is asked with. */
export type EvidenceContext = Parameters<typeof checkDeliveryStatus>[3];

/** How many addresses one gateway request carries, and how many run at once. */
const EMAILS_PER_REQUEST = 100;
const REQUEST_CONCURRENCY = 6;

/** Raised when the delivery layer could not be asked. The caller answers 502, never a zero. */
export class EvidenceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceUnavailableError";
  }
}

/** One address to answer for, and the brand its question is asked under. */
export interface EvidenceRequest {
  brandId: string;
  email: string;
}

export interface EvidenceReadOptions {
  orgId: string;
  /** The single campaign a campaign-mode question names, or undefined for brand mode. */
  campaignId: string | undefined;
  /** The oldest stored answer this read accepts; anything asked before it is asked again. */
  acceptFetchedSince: Date;
  /**
   * Addresses whose delivery evidence is known to have CHANGED (a pushed change), keyed by the
   * lower-cased address, with the instant of the change: a stored answer asked before that instant
   * is asked again whatever its age. One asked after it already reflects the change.
   */
  changedAt?: ReadonlyMap<string, Date>;
  context: EvidenceContext;
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}

interface StoredEvidence {
  email: string;
  result: StatusResult | null;
  fetched_at: Date | string;
}

/**
 * The gateway's answer for every address in `requests`, keyed by email — read from what is stored
 * when it is recent enough, asked again (and stored) when it is not.
 *
 * An address the gateway answered with nothing is stored as a NULL result: "we asked and there is
 * nothing" is an answer, and re-asking it on every read would put the fan-out straight back.
 */
export async function readDeliveryEvidence(
  requests: readonly EvidenceRequest[],
  options: EvidenceReadOptions,
): Promise<Map<string, StatusResult>> {
  const out = new Map<string, StatusResult>();
  if (requests.length === 0) return out;

  const campaignKey = options.campaignId ?? "";
  const byBrand = new Map<string, Set<string>>();
  for (const r of requests) {
    if (!byBrand.has(r.brandId)) byBrand.set(r.brandId, new Set());
    byBrand.get(r.brandId)!.add(r.email);
  }

  const toFetch: Array<{ brandId: string; emails: string[] }> = [];
  const acceptSince = options.acceptFetchedSince.getTime();

  for (const [brandId, emailSet] of byBrand) {
    const emails = [...emailSet];
    const stored = await sql<StoredEvidence[]>`
      SELECT email, result, fetched_at
      FROM lead_delivery_evidence
      WHERE org_id = ${options.orgId}
        AND brand_id = ${brandId}
        AND campaign_id = ${campaignKey}
        AND email = ANY(${emails}::text[])
    `;
    const fresh = new Set<string>();
    for (const row of stored) {
      const fetchedAt = new Date(row.fetched_at).getTime();
      if (fetchedAt < acceptSince) continue;
      const changedAt = options.changedAt?.get(row.email.toLowerCase());
      if (changedAt && fetchedAt < changedAt.getTime()) continue;
      fresh.add(row.email);
      if (row.result) out.set(row.email, row.result);
    }
    const missing = emails.filter((e) => !fresh.has(e));
    for (let i = 0; i < missing.length; i += EMAILS_PER_REQUEST) {
      toFetch.push({ brandId, emails: missing.slice(i, i + EMAILS_PER_REQUEST) });
    }
  }

  if (toFetch.length === 0) return out;

  // Stamped with when the question was ASKED, not when it was stored: the answer describes the
  // world as of the request, so that is the only honest age to give it.
  const askedAt = new Date().toISOString();
  await mapWithConcurrency(toFetch, REQUEST_CONCURRENCY, async (batch) => {
    let response;
    try {
      response = await checkDeliveryStatus(
        batch.brandId,
        options.campaignId,
        batch.emails.map((email) => ({ email })),
        options.context,
      );
    } catch (error) {
      throw new EvidenceUnavailableError((error as Error).message);
    }
    const answered = new Map<string, StatusResult>();
    for (const result of response.results) answered.set(result.email, result);
    for (const [email, result] of answered) out.set(email, result);
    const emails = batch.emails;
    const results = emails.map((e) => {
      const r = answered.get(e);
      return r ? JSON.stringify(r) : null;
    });
    await sql`
      INSERT INTO lead_delivery_evidence (org_id, brand_id, campaign_id, email, result, fetched_at)
      SELECT ${options.orgId}, ${batch.brandId}, ${campaignKey}, u.email, u.result::jsonb, ${askedAt}::timestamptz
      FROM unnest(${emails}::text[], ${results}::text[]) AS u(email, result)
      ON CONFLICT (org_id, brand_id, campaign_id, email)
      DO UPDATE SET result = EXCLUDED.result, fetched_at = EXCLUDED.fetched_at
      WHERE lead_delivery_evidence.fetched_at <= EXCLUDED.fetched_at
    `;
  });

  return out;
}
