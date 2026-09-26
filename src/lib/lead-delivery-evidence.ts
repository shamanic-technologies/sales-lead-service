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
import { createHash } from "node:crypto";
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
 * When an address was last asked and the gateway gave back the SAME answer that is stored.
 *
 * Every read model refresh and every feed reconcile asks the gateway again about its whole scope,
 * and almost every answer is the one already stored. Rewriting the row just to move `fetched_at`
 * was ~112M updates in a few days — a large share of the box's write load for no new information.
 * So an unchanged answer is not written; the moment it was confirmed is kept here, and a read takes
 * the later of the two as the answer's age. The stored row is still exactly the gateway's latest
 * answer; only its "last asked" instant can be newer in memory than on disk.
 *
 * A confirmation names the answer it confirmed (a digest), and counts only while the stored row
 * still holds that answer — so a concurrent writer storing a DIFFERENT answer is never made to look
 * fresher by a confirmation of the one it replaced.
 *
 * In-process on purpose: losing it (a restart) only makes stored answers look as old as their row
 * says, so they are asked again once — never served past a bound. Bounded by clearing, same effect.
 */
const confirmedAt = new Map<string, { at: number; digest: string }>();
const MAX_CONFIRMED = 500_000;

function evidenceKey(orgId: string, brandId: string, campaignKey: string, email: string): string {
  return `${orgId}\u0000${brandId}\u0000${campaignKey}\u0000${email}`;
}

/** A digest of an answer with object keys sorted — equal whatever key order jsonb kept. */
function digestOf(value: unknown): string {
  const canonical = JSON.stringify(value ?? null, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
  return createHash("sha1").update(canonical).digest("base64url");
}

/** Test seam: forget every in-memory confirmation. */
export function resetEvidenceConfirmations(): void {
  confirmedAt.clear();
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
  /** What is stored for each address asked again, so an unchanged answer is not rewritten. */
  const storedResult = new Map<string, string>();

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
      const key = evidenceKey(options.orgId, brandId, campaignKey, row.email);
      const digest = digestOf(row.result);
      const confirmed = confirmedAt.get(key);
      const fetchedAt = Math.max(
        new Date(row.fetched_at).getTime(),
        confirmed && confirmed.digest === digest ? confirmed.at : 0,
      );
      storedResult.set(key, digest);
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
    // Only what is new or different is written; an answer identical to the stored one is only
    // remembered as confirmed now (see `confirmedAt`).
    const emails: string[] = [];
    const results: Array<string | null> = [];
    const askedAtMs = Date.parse(askedAt);
    if (confirmedAt.size > MAX_CONFIRMED) confirmedAt.clear();
    for (const email of batch.emails) {
      const r = answered.get(email) ?? null;
      const key = evidenceKey(options.orgId, batch.brandId, campaignKey, email);
      const held = storedResult.get(key);
      if (held !== undefined && held === digestOf(r)) {
        const prior = confirmedAt.get(key);
        confirmedAt.set(key, {
          at: prior && prior.digest === held ? Math.max(prior.at, askedAtMs) : askedAtMs,
          digest: held,
        });
        continue;
      }
      emails.push(email);
      results.push(r ? JSON.stringify(r) : null);
    }
    if (emails.length === 0) return;
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
