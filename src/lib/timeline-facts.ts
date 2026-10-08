/**
 * Writes and reads the SILVER timeline (`lead_timeline_facts`, migration 0059): one labelled row per
 * fact about a person at a brand, whichever channel it came by. Vocabulary and gold derivation live
 * in `timeline-labels.ts` (pure); this module is the IO.
 *
 * Sources today, each re-read whole per brand on every sweep and written idempotently (`id` =
 * source:source_ref, so a re-read rewrites the same row and a changed verdict relabels it):
 *   - step outcomes this service holds (`conversion_events`: tracker, a person's statement, the
 *     customer's CRM, an "already a client" reply) with the effective whose-win answer;
 *   - "this will never happen" statements (`lead_step_disqualifications`), labelled not_interested;
 *   - every reply, with the verdict instantly-service holds for it (reply-verdicts-client.ts).
 * What we SENT and how the person reacted to it (sends, opens, clicks with their URL, bounces,
 * unsubscribes) arrive with the outreach provider's fact feed, requested from instantly-service.
 *
 * FAIL LOUD per brand: a source that cannot be read fails that brand's sweep and leaves its rows as
 * they were (never an empty write that would read as "nothing happened"); the sweep moves on.
 */
import { sql } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { fetchOrgCampaignOffers } from "./campaign-leg-client.js";
import { fetchReplyVerdicts } from "./reply-verdicts-client.js";
import {
  conversationTags,
  outcomeLabel,
  replyLabel,
  type ConversationTags,
  type TimelineAttributionBasis,
  type TimelineItem,
  type TimelineItemLabel,
  type TimelineSource,
} from "./timeline-labels.js";

export const TIMELINE_SYNC_INTERVAL_MS = 15 * 60_000;
const FIRST_SWEEP_DELAY_MS = 90_000;
const WRITE_CHUNK = 500;

/** One silver row, as written. */
export interface TimelineFactRow {
  id: string;
  org_id: string;
  brand_id: string;
  offer_id: string | null;
  lead_id: string;
  campaign_id: string | null;
  occurred_at: string | null;
  label: TimelineItemLabel;
  source: TimelineSource;
  source_ref: string;
  attributable: boolean | null;
  attribution_basis: TimelineAttributionBasis | null;
  url: string | null;
  detail: Record<string, unknown>;
  withdrawn_at: string | null;
}

/** campaign -> offer, or null when the campaign is unknown to campaign-service. */
function offerOf(offers: ReadonlyMap<string, string | null>, campaignId: string | null): string | null {
  if (!campaignId) return null;
  return offers.get(campaignId) ?? null;
}

interface OutcomeSourceRow {
  id: string;
  event: string;
  source: string;
  lead_id: string;
  campaign_id: string | null;
  received_at: Date | string | null;
  caused_by_outreach: boolean | null;
  stated_caused_by_outreach: boolean | null;
  cause_rule: unknown;
  value_cents: number | null;
  withdrawn_at: Date | string | null;
}

/** The source of an outcome row, as the timeline names it. */
function outcomeSource(source: string): TimelineSource {
  if (source === "tracker" || source === "manual" || source === "crm") return source;
  if (source === "reply") return "reply_statement";
  throw new Error(`conversion_events.source '${source}' has no timeline source`);
}

export function outcomeRows(
  orgId: string,
  brandId: string,
  rows: readonly OutcomeSourceRow[],
  offers: ReadonlyMap<string, string | null>,
): { rows: TimelineFactRow[]; unplaced: number } {
  const out: TimelineFactRow[] = [];
  let unplaced = 0;
  for (const r of rows) {
    const label = outcomeLabel(r.event);
    if (!label) {
      unplaced++;
      continue;
    }
    const basis: TimelineAttributionBasis | null =
      r.caused_by_outreach === null ? null : r.stated_caused_by_outreach !== null ? "person" : "rule";
    out.push({
      id: `outcome:${r.id}`,
      org_id: orgId,
      brand_id: brandId,
      offer_id: offerOf(offers, r.campaign_id),
      lead_id: r.lead_id,
      campaign_id: r.campaign_id,
      occurred_at: toIsoTimestamp(r.received_at),
      label,
      source: outcomeSource(r.source),
      source_ref: r.id,
      attributable: r.caused_by_outreach,
      attribution_basis: basis,
      url: null,
      detail: { event: r.event, valueCents: r.value_cents },
      withdrawn_at: toIsoTimestamp(r.withdrawn_at),
    });
  }
  return { rows: out, unplaced };
}

interface NeverSourceRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  step: string;
  source: string;
  /** A person's statement: when it was stated. A CRM never: when their CRM says, NULL = undated. */
  at: Date | string | null;
  gone_at: Date | string | null;
}

export function neverRows(
  orgId: string,
  brandId: string,
  rows: readonly NeverSourceRow[],
  offers: ReadonlyMap<string, string | null>,
): TimelineFactRow[] {
  return rows.map((r) => ({
    id: `never:${r.id}`,
    org_id: orgId,
    brand_id: brandId,
    offer_id: offerOf(offers, r.campaign_id),
    lead_id: r.lead_id,
    campaign_id: r.campaign_id,
    occurred_at: toIsoTimestamp(r.at),
    label: "not_interested",
    source: r.source === "crm" ? "crm" : "never",
    source_ref: r.id,
    attributable: true,
    attribution_basis: "stated_on_our_lead",
    url: null,
    detail: { step: r.step },
    withdrawn_at: toIsoTimestamp(r.gone_at),
  }));
}

async function readOutcomes(orgId: string, brandId: string): Promise<OutcomeSourceRow[]> {
  return (await sql`
    SELECT id::text AS id, event, source, matched_lead_id::text AS lead_id, campaign_id, received_at,
      caused_by_outreach, stated_caused_by_outreach, cause_rule, value_cents, withdrawn_at
    FROM conversion_events
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
      AND matched_lead_id IS NOT NULL AND attribution_status = 'attributed'
  `) as unknown as OutcomeSourceRow[];
}

async function readNevers(orgId: string, brandId: string): Promise<NeverSourceRow[]> {
  return (await sql`
    SELECT id::text AS id, lead_id::text AS lead_id, campaign_id, step, source,
      CASE WHEN source = 'crm' THEN occurred_at ELSE created_at END AS at,
      COALESCE(withdrawn_at, retracted_at) AS gone_at
    FROM lead_step_disqualifications
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
  `) as unknown as NeverSourceRow[];
}

/** Every email of a person this brand worked, case-folded, and whose lead it is. */
async function readServedEmails(orgId: string, brandId: string): Promise<Map<string, string>> {
  const rows = (await sql`
    SELECT DISTINCT lower(cm.value) AS email, cm.lead_id::text AS lead_id
    FROM leads_campaigns lc
    JOIN lead_contact_methods cm ON cm.lead_id = lc.lead_id AND cm.channel = 'email'
    WHERE lc.org_id = ${orgId} AND ${brandId} = ANY(lc.brand_ids) AND lc.status = 'served'
  `) as unknown as Array<{ email: string; lead_id: string }>;
  return new Map(rows.map((r) => [r.email, r.lead_id]));
}

async function replyRows(
  orgId: string,
  brandId: string,
  offers: ReadonlyMap<string, string | null>,
): Promise<{ rows: TimelineFactRow[]; unjudged: number }> {
  const leadByEmail = await readServedEmails(orgId, brandId);
  if (leadByEmail.size === 0) return { rows: [], unjudged: 0 };
  const replies = await fetchReplyVerdicts([...leadByEmail.keys()], { orgId });
  const rows: TimelineFactRow[] = [];
  let unjudged = 0;
  for (const r of replies) {
    if (!r.brandIds.includes(brandId)) continue;
    const leadId = leadByEmail.get(r.leadEmail.toLowerCase());
    if (!leadId) continue;
    const label = replyLabel(r.verdict);
    if (!label) {
      unjudged++;
      continue;
    }
    rows.push({
      id: `reply:${r.replyId}`,
      org_id: orgId,
      brand_id: brandId,
      offer_id: offerOf(offers, r.campaignId),
      lead_id: leadId,
      campaign_id: r.campaignId,
      occurred_at: r.receivedAt,
      label,
      source: "reply",
      source_ref: r.replyId,
      attributable: true,
      attribution_basis: "reaction_to_our_email",
      url: null,
      detail: { subject: r.subject, classification: r.verdict?.classification ?? null, judgedBy: r.verdict?.producerType ?? null },
      withdrawn_at: null,
    });
  }
  return { rows, unjudged };
}

/** Write rows idempotently: a row whose content did not change is not touched. */
export async function upsertTimelineFacts(rows: readonly TimelineFactRow[]): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    const result = await sql`
      INSERT INTO lead_timeline_facts AS t (id, org_id, brand_id, offer_id, lead_id, campaign_id,
        occurred_at, label, source, source_ref, attributable, attribution_basis, url, detail, withdrawn_at)
      SELECT x.id, x.org_id, x.brand_id, x.offer_id, x.lead_id::uuid, x.campaign_id,
        x.occurred_at::timestamptz, x.label, x.source, x.source_ref, x.attributable,
        x.attribution_basis, x.url, COALESCE(x.detail, '{}'::jsonb), x.withdrawn_at::timestamptz
      FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS x(
        id text, org_id text, brand_id text, offer_id text, lead_id text, campaign_id text,
        occurred_at text, label text, source text, source_ref text, attributable boolean,
        attribution_basis text, url text, detail jsonb, withdrawn_at text)
      ON CONFLICT (id) DO UPDATE SET
        offer_id = EXCLUDED.offer_id, lead_id = EXCLUDED.lead_id, campaign_id = EXCLUDED.campaign_id,
        occurred_at = EXCLUDED.occurred_at, label = EXCLUDED.label, attributable = EXCLUDED.attributable,
        attribution_basis = EXCLUDED.attribution_basis, url = EXCLUDED.url, detail = EXCLUDED.detail,
        withdrawn_at = EXCLUDED.withdrawn_at, updated_at = now()
      WHERE (t.offer_id, t.lead_id, t.campaign_id, t.occurred_at, t.label, t.attributable,
          t.attribution_basis, t.url, t.detail, t.withdrawn_at)
        IS DISTINCT FROM (EXCLUDED.offer_id, EXCLUDED.lead_id, EXCLUDED.campaign_id, EXCLUDED.occurred_at,
          EXCLUDED.label, EXCLUDED.attributable, EXCLUDED.attribution_basis, EXCLUDED.url,
          EXCLUDED.detail, EXCLUDED.withdrawn_at)
    `;
    written += result.count;
  }
  return written;
}

export interface TimelineSyncResult {
  outcomes: number;
  nevers: number;
  replies: number;
  unjudgedReplies: number;
  unplacedOutcomes: number;
  written: number;
}

/** Re-read every source of one brand and write what changed. Throws when a source is unreadable. */
export async function syncTimelineFacts(orgId: string, brandId: string): Promise<TimelineSyncResult> {
  const offers = await fetchOrgCampaignOffers({ orgId });
  const outcomes = outcomeRows(orgId, brandId, await readOutcomes(orgId, brandId), offers);
  const nevers = neverRows(orgId, brandId, await readNevers(orgId, brandId), offers);
  const replies = await replyRows(orgId, brandId, offers);
  const written = await upsertTimelineFacts([...outcomes.rows, ...nevers, ...replies.rows]);
  return {
    outcomes: outcomes.rows.length,
    nevers: nevers.length,
    replies: replies.rows.length,
    unjudgedReplies: replies.unjudged,
    unplacedOutcomes: outcomes.unplaced,
    written,
  };
}

/** Every brand that worked somebody, or holds an outcome. */
async function listTimelineBrands(): Promise<Array<{ org_id: string; brand_id: string }>> {
  return (await sql`
    SELECT DISTINCT lc.org_id, b AS brand_id
    FROM leads_campaigns lc, unnest(lc.brand_ids) AS b
    WHERE lc.status = 'served'
    UNION
    SELECT DISTINCT org_id, brand_id FROM conversion_events WHERE matched_lead_id IS NOT NULL
  `) as unknown as Array<{ org_id: string; brand_id: string }>;
}

let sweeping = false;

export async function sweepTimelineFacts(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const { org_id, brand_id } of await listTimelineBrands()) {
      try {
        const r = await syncTimelineFacts(org_id, brand_id);
        if (r.written > 0 || r.unplacedOutcomes > 0) {
          console.log(
            `[lead-service] timeline brand=${brand_id} outcomes=${r.outcomes} nevers=${r.nevers} ` +
              `replies=${r.replies} unjudged=${r.unjudgedReplies} unplaced=${r.unplacedOutcomes} written=${r.written}`,
          );
        }
      } catch (error) {
        console.error(
          `[lead-service] timeline brand=${brand_id} org=${org_id} could not be synced, its facts stay ` +
            `as they were: ${(error as Error).message}`,
        );
      }
    }
  } finally {
    sweeping = false;
  }
}

export function startTimelineFactsWorker(): void {
  const tick = () => {
    sweepTimelineFacts().catch((error) => console.error("[lead-service] timeline sweep failed:", error));
  };
  setTimeout(tick, FIRST_SWEEP_DELAY_MS).unref();
  setInterval(tick, TIMELINE_SYNC_INTERVAL_MS).unref();
}

interface StoredRow {
  id: string;
  label: TimelineItemLabel;
  source: TimelineSource;
  occurred_at: Date | string | null;
  attributable: boolean | null;
  attribution_basis: TimelineAttributionBasis | null;
  campaign_id: string | null;
  offer_id: string | null;
  url: string | null;
  detail: Record<string, unknown>;
  withdrawn_at: Date | string | null;
}

export interface TimelineRead {
  items: Array<TimelineItem & { detail: Record<string, unknown> }>;
  tags: ConversationTags;
}

/**
 * One conversation: a person at a brand, narrowed to one offer when named (the offer's facts plus
 * the brand-level ones, which belong to every offer page). Live items only feed the tags; withdrawn
 * items are served too, marked, because the record of a fact taken back is part of the timeline.
 */
export async function readTimeline(input: {
  orgId: string;
  brandId: string;
  leadId: string;
  offerId: string | null;
}): Promise<TimelineRead> {
  const rows = (await sql`
    SELECT id, label, source, occurred_at, attributable, attribution_basis, campaign_id, offer_id,
      url, detail, withdrawn_at
    FROM lead_timeline_facts
    WHERE org_id = ${input.orgId} AND brand_id = ${input.brandId} AND lead_id = ${input.leadId}
      AND (${input.offerId}::text IS NULL OR offer_id IS NULL OR offer_id = ${input.offerId})
    ORDER BY occurred_at ASC NULLS LAST, id ASC
  `) as unknown as StoredRow[];
  const items = rows.map((r) => ({
    id: r.id,
    label: r.label,
    source: r.source,
    occurredAt: toIsoTimestamp(r.occurred_at),
    attributable: r.attributable,
    attributionBasis: r.attribution_basis,
    campaignId: r.campaign_id,
    offerId: r.offer_id,
    url: r.url,
    withdrawnAt: toIsoTimestamp(r.withdrawn_at),
    detail: r.detail,
  }));
  return { items, tags: conversationTags(items) };
}
