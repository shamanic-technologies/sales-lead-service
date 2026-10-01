/**
 * "This person ALREADY buys from the brand" — read off the prospect's own reply.
 *
 * A prospect answers a cold email with "I'm already one of your clinics, I have the unit — is this
 * meant for people who don't?". They are a WON customer of the brand, and our outreach did not win
 * them. The owner's ruling: the lead reads as won, not ours. So this is a `sale` on the outcome
 * ledger (`conversion_events`), exactly what makes a lead's standing `customer` and what
 * `/won-leads` answers with, carrying:
 *
 *   - `source = 'reply'`        — neither a person of the customer's (manual), the website tag
 *                                 (tracker) nor their CRM: the PROSPECT's words, read by the service
 *                                 that classified the reply. `bySource.reply` keeps the split exact.
 *   - `caused_by_outreach = false` and `stated_caused_by_outreach = false` — whose win it was is
 *                                 ANSWERED (by the prospect), so the owner's date rule never
 *                                 overwrites it (outcome-cause.ts is guarded on the stated column).
 *                                 It lands in `byCause.other`, which every consumer computing the
 *                                 return on OUR outreach leaves out (features-service prices
 *                                 `outreach` only).
 *   - `value_cents` / `cost_cents` NULL — nobody knows either, and inventing a value would
 *                                 fabricate revenue. A stated sale by a PERSON must carry both; this
 *                                 is not a person's statement, which is why it has its own door.
 *   - `received_at` NULL        — UNDATED. They became a customer at some moment we were never
 *                                 told; every dated read answers it in its `undated` bucket.
 *
 * It is the WEAKEST evidence of a sale, so it never stacks on another one (the ledger counts ROWS,
 * and two rows for one deal would count it twice):
 *   - a live sale for this person at this brand from ANY other source → nothing written
 *     (`already_won`);
 *   - a person, the tracker or the CRM later stating the sale SETS THIS ROW ASIDE
 *     (`supersedeReplyOutcome`), never deletes it;
 *   - a person's live "never" on the sale outranks a classifier reading → refused (`stated_never`).
 *
 * Keyed to the PERSON at the brand (`r:<leadId>:sale`), so stating it twice records it once, and a
 * restatement after a withdrawal revives the same row.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { lookupFollowupRowByEmail } from "./followup-queue.js";
import { statementSourceOf, type StatementSource } from "./step-statements.js";

export const EXISTING_CUSTOMER_STEP = "sale" as const;

/** One row per person per brand. The `r:` prefix keeps it disjoint from `m:`/`k:`/`a:`/CRM ones. */
export function replyOutcomeSignature(leadId: string): string {
  return `r:${leadId}:${EXISTING_CUSTOMER_STEP}`;
}

const SALE_SPELLINGS = ["sale", "purchase"];

export interface ExistingCustomerOutcome {
  id: string;
  leadId: string;
  leadCampaignId: string;
  campaignId: string;
  brandId: string;
  email: string;
  step: typeof EXISTING_CUSTOMER_STEP;
  source: "reply";
  valueCents: null;
  costCents: null;
  causedByOutreach: false;
  occurredAt: null;
  replyRef: string | null;
  recordedAt: string | null;
}

export type ExistingCustomerResult =
  | { ok: true; status: "recorded" | "already_recorded"; outcome: ExistingCustomerOutcome }
  | {
      ok: true;
      status: "already_won";
      leadId: string;
      leadCampaignId: string;
      brandId: string;
      email: string;
      wonBy: StatementSource;
    }
  | { ok: false; code: "lead_not_found" }
  | { ok: false; code: "ambiguous_lead"; matches: Array<{ id: string; leadId: string; email: string }> }
  | { ok: false; code: "lead_has_no_brand" }
  | { ok: false; code: "stated_never"; leadId: string; leadCampaignId: string };

export type WithdrawExistingCustomerResult =
  | { ok: true; withdrawn: boolean; alreadyWithdrawn: boolean; leadId: string; leadCampaignId: string; brandId: string }
  | { ok: false; code: "lead_not_found" }
  | { ok: false; code: "ambiguous_lead"; matches: Array<{ id: string; leadId: string; email: string }> }
  | { ok: false; code: "lead_has_no_brand" }
  | { ok: false; code: "nothing_recorded" };

interface ResolvedRow {
  id: string;
  leadId: string;
  email: string;
  brandId: string;
}

/**
 * The lead row, found EXACTLY the way the follow-up queue's by-email door finds it (org + campaign +
 * case-folded registered address), and the brand the row is about (its primary brand, as a
 * statement made from the row is).
 */
async function resolveRow(params: {
  orgId: string;
  campaignId: string;
  email: string;
}): Promise<
  | { ok: true; row: ResolvedRow }
  | { ok: false; code: "lead_not_found" }
  | { ok: false; code: "ambiguous_lead"; matches: Array<{ id: string; leadId: string; email: string }> }
  | { ok: false; code: "lead_has_no_brand" }
> {
  const lookup = await lookupFollowupRowByEmail(params);
  if (!lookup.ok) return lookup;

  const brands = (await db.execute(sql`
    SELECT brand_ids FROM leads_campaigns WHERE id = ${lookup.id} AND org_id = ${params.orgId} LIMIT 1
  `)) as unknown as Array<{ brand_ids: string[] | null }>;
  if (brands.length === 0) return { ok: false, code: "lead_not_found" };
  const brandId = brands[0].brand_ids?.[0] ?? null;
  if (!brandId) return { ok: false, code: "lead_has_no_brand" };

  return { ok: true, row: { id: lookup.id, leadId: lookup.leadId, email: lookup.email, brandId } };
}

export async function recordExistingCustomerFromReply(params: {
  orgId: string;
  campaignId: string;
  email: string;
  replyRef: string | null;
}): Promise<ExistingCustomerResult> {
  const resolved = await resolveRow(params);
  if (!resolved.ok) return resolved;
  const { row } = resolved;

  // Another source already holds this person's sale: that evidence is stronger (it carries a
  // value, a date, a person), and a second row would count the deal twice.
  const otherSale = (await db.execute(sql`
    SELECT source
    FROM conversion_events
    WHERE brand_id = ${row.brandId}
      AND matched_lead_id = ${row.leadId}
      AND event = ANY(${sql.param(SALE_SPELLINGS)}::text[])
      AND source <> 'reply'
      AND attribution_status = 'attributed'
      AND withdrawn_at IS NULL
    ORDER BY (source = 'manual') DESC, received_at DESC NULLS LAST
    LIMIT 1
  `)) as unknown as Array<{ source: string }>;
  if (otherSale.length > 0) {
    return {
      ok: true,
      status: "already_won",
      leadId: row.leadId,
      leadCampaignId: row.id,
      brandId: row.brandId,
      email: row.email,
      wonBy: statementSourceOf(otherSale[0].source),
    };
  }

  // A person of the customer's said this sale will NEVER happen: a classifier's reading of a reply
  // does not overrule them. (A CRM "never" does not stop it: the prospect's words are the newer fact.)
  const personNever = (await db.execute(sql`
    SELECT 1 AS hit
    FROM lead_step_disqualifications
    WHERE lead_id = ${row.leadId}
      AND brand_id = ${row.brandId}
      AND step = ${EXISTING_CUSTOMER_STEP}
      AND source = 'manual'
      AND retracted_at IS NULL
      AND withdrawn_at IS NULL
    LIMIT 1
  `)) as unknown as Array<{ hit: number }>;
  if (personNever.length > 0) {
    return { ok: false, code: "stated_never", leadId: row.leadId, leadCampaignId: row.id };
  }

  const note = params.replyRef ? `reply:${params.replyRef}` : null;

  // `inserted` tells a first statement from a restatement (xmax = 0 only on a fresh insert).
  const written = (await db.execute(sql`
    INSERT INTO conversion_events (
      brand_id, org_id, event, email, dedupe_signature, value_cents, cost_cents,
      caused_by_outreach, stated_caused_by_outreach, matched_lead_id, match_method,
      match_confidence, attribution_status, candidate_count, received_at, source, campaign_id,
      lead_campaign_id, note
    ) VALUES (
      ${row.brandId}, ${params.orgId}, ${EXISTING_CUSTOMER_STEP}, ${row.email},
      ${replyOutcomeSignature(row.leadId)}, NULL, NULL,
      false, false, ${row.leadId}, 'email',
      'deterministic', 'attributed', 1, NULL, 'reply', ${params.campaignId},
      ${row.id}, ${note}
    )
    ON CONFLICT (brand_id, dedupe_signature) WHERE dedupe_signature IS NOT NULL DO UPDATE SET
      -- Stating it again revives a row that was withdrawn or set aside (nothing else holds the
      -- sale any more: checked above), and keeps the latest reply as its provenance.
      withdrawn_at = NULL,
      withdrawn_by_user_id = NULL,
      note = COALESCE(EXCLUDED.note, conversion_events.note)
    WHERE conversion_events.source = 'reply'
    RETURNING id, campaign_id, lead_campaign_id, note, created_at, (xmax = 0) AS inserted,
              (SELECT withdrawn_at IS NOT NULL FROM conversion_events prior
                WHERE prior.brand_id = ${row.brandId}
                  AND prior.dedupe_signature = ${replyOutcomeSignature(row.leadId)}) AS was_withdrawn
  `)) as unknown as Array<{
    id: string;
    campaign_id: string;
    lead_campaign_id: string;
    note: string | null;
    created_at: Date | string | null;
    inserted: boolean;
    was_withdrawn: boolean | null;
  }>;

  if (written.length === 0) {
    // The signature is held by a row that is not ours to touch (cannot happen: the prefix is ours).
    throw new Error(
      `existing-customer: signature ${replyOutcomeSignature(row.leadId)} is held by a non-reply row`,
    );
  }
  const w = written[0];
  const status = w.inserted || w.was_withdrawn ? "recorded" : "already_recorded";

  return {
    ok: true,
    status,
    outcome: {
      id: w.id,
      leadId: row.leadId,
      leadCampaignId: w.lead_campaign_id,
      campaignId: w.campaign_id,
      brandId: row.brandId,
      email: row.email,
      step: EXISTING_CUSTOMER_STEP,
      source: "reply",
      valueCents: null,
      costCents: null,
      causedByOutreach: false,
      occurredAt: null,
      replyRef: w.note?.startsWith("reply:") ? w.note.slice("reply:".length) : null,
      recordedAt: toIsoTimestamp(w.created_at),
    },
  };
}

/**
 * The classifier takes its reading back (it re-read the reply, or a person corrected the verdict).
 * The row is set aside, never deleted. Idempotent: a second withdrawal reports `alreadyWithdrawn`.
 */
export async function withdrawExistingCustomerFromReply(params: {
  orgId: string;
  campaignId: string;
  email: string;
}): Promise<WithdrawExistingCustomerResult> {
  const resolved = await resolveRow(params);
  if (!resolved.ok) return resolved;
  const { row } = resolved;

  const rows = (await db.execute(sql`
    SELECT id, withdrawn_at
    FROM conversion_events
    WHERE brand_id = ${row.brandId}
      AND dedupe_signature = ${replyOutcomeSignature(row.leadId)}
      AND source = 'reply'
    LIMIT 1
  `)) as unknown as Array<{ id: string; withdrawn_at: Date | string | null }>;
  if (rows.length === 0) return { ok: false, code: "nothing_recorded" };

  const base = { leadId: row.leadId, leadCampaignId: row.id, brandId: row.brandId };
  if (rows[0].withdrawn_at !== null) {
    return { ok: true, withdrawn: false, alreadyWithdrawn: true, ...base };
  }
  await db.execute(sql`
    UPDATE conversion_events SET withdrawn_at = now()
    WHERE id = ${rows[0].id} AND withdrawn_at IS NULL
  `);
  return { ok: true, withdrawn: true, alreadyWithdrawn: false, ...base };
}

/**
 * Stronger evidence of this person's sale just landed (a person stated it, the tracker reported
 * it, the CRM evidences it): the reply-read row is set aside so the deal counts once.
 */
export async function supersedeReplyOutcome(
  brandId: string,
  leadId: string,
  step: string,
): Promise<void> {
  if (!SALE_SPELLINGS.includes(step)) return;
  await db.execute(sql`
    UPDATE conversion_events
    SET withdrawn_at = now()
    WHERE brand_id = ${brandId}
      AND source = 'reply'
      AND matched_lead_id = ${leadId}
      AND event = ANY(${sql.param(SALE_SPELLINGS)}::text[])
      AND withdrawn_at IS NULL
  `);
}
