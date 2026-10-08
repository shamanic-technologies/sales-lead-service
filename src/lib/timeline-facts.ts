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
import { getBrandSite } from "./brand-client.js";
import { loadOutreachFeedState } from "./outreach-fact-feed.js";
import {
  clickLabel,
  conversationTags,
  hostOf,
  outcomeLabel,
  replyLabel,
  type ConversationTags,
  type PlaceableJudgments,
  type PlaceableVerdict,
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
    // An "already a client" sale is read off the prospect's reply; the reply item states it (as a
    // paid client, not ours), so the same fact is not written twice.
    if (r.source === "reply") continue;
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

/** Every email of a person this org knows, case-folded, and whose lead it is. */
async function readLeadEmails(emails: readonly string[]): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map();
  const rows = (await sql`
    SELECT lower(value) AS email, lead_id::text AS lead_id
    FROM lead_contact_methods
    WHERE channel = 'email' AND lower(value) IN (SELECT jsonb_array_elements_text(${JSON.stringify(emails)}::jsonb))
  `) as unknown as Array<{ email: string; lead_id: string }>;
  return new Map(rows.map((r) => [r.email, r.lead_id]));
}

interface OutreachFactRow {
  seq: string;
  subject_key: string;
  type: string;
  occurred_at: Date | string | null;
  lead_email: string;
  campaign_id: string | null;
  raw: Record<string, unknown>;
}

/** The CURRENT fact per subject for one brand (a correction supersedes; a withdrawal ends it). */
async function readOutreachFacts(orgId: string, brandId: string): Promise<OutreachFactRow[]> {
  return (await sql`
    SELECT DISTINCT ON (subject_key) seq::text AS seq, subject_key, type, occurred_at, lead_email,
      campaign_id, raw
    FROM outreach_facts
    WHERE org_id = ${orgId} AND brand_ids @> ARRAY[${brandId}]::text[]
    ORDER BY subject_key, seq DESC
  `) as unknown as OutreachFactRow[];
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** The hosts of the brand's own site, read once per brand and only when a click names a URL. */
type SiteHosts = (offerId: string | null) => Promise<string[]>;

/**
 * One current outreach fact, labelled. A withdrawn subject keeps its row, marked. A reply nobody
 * judged yet writes nothing (it is re-read next sweep). A fact type this vocabulary does not hold
 * writes nothing and is counted.
 */
export async function outreachRow(
  orgId: string,
  brandId: string,
  fact: OutreachFactRow,
  leadId: string,
  offers: ReadonlyMap<string, string | null>,
  siteHosts: SiteHosts,
): Promise<TimelineFactRow | "unjudged" | "unplaced"> {
  const offerId = offerOf(offers, fact.campaign_id);
  const base = {
    id: fact.subject_key,
    org_id: orgId,
    brand_id: brandId,
    offer_id: offerId,
    lead_id: leadId,
    campaign_id: fact.campaign_id,
    occurred_at: toIsoTimestamp(fact.occurred_at),
    source: "outreach" as TimelineSource,
    source_ref: fact.subject_key,
    url: null as string | null,
    withdrawn_at: null as string | null,
  };
  const ours = { attributable: true, attribution_basis: "reaction_to_our_email" as TimelineAttributionBasis };
  switch (fact.type) {
    case "email_sent": {
      const send = obj(fact.raw.send);
      if (!send || (send.position !== "first" && send.position !== "followup")) return "unplaced";
      return { ...base, label: send.position === "first" ? "initial_email" : "followup", attributable: true,
        attribution_basis: "our_email", detail: { step: send.step ?? null } };
    }
    case "email_opened":
      return { ...base, ...ours, label: "opened", detail: { step: obj(fact.raw.open)?.step ?? null } };
    case "link_clicked": {
      const click = obj(fact.raw.click);
      const url = typeof click?.url === "string" && click.url.length > 0 ? click.url : null;
      const label = clickLabel(url, url === null ? [] : await siteHosts(offerId));
      return { ...base, ...ours, label, url, detail: { step: click?.step ?? null } };
    }
    case "email_bounced":
      return { ...base, label: "bounced", attributable: true, attribution_basis: "our_email",
        detail: { step: obj(fact.raw.bounce)?.step ?? null } };
    case "unsubscribed":
      return { ...base, ...ours, label: "unsubscribed", detail: { via: obj(fact.raw.unsubscribe)?.via ?? null } };
    case "reply": {
      const reply = obj(fact.raw.reply);
      const verdict = obj(reply?.verdict);
      if (!reply) return "unplaced";
      const label = replyLabel(verdict as unknown as PlaceableVerdict | null, obj(reply.judgments) as PlaceableJudgments | null);
      if (!label) return "unjudged";
      const alreadyClient = label === "paid_client";
      return {
        ...base,
        source: "reply",
        source_ref: typeof reply.replyId === "string" ? reply.replyId : fact.subject_key,
        label,
        attributable: alreadyClient ? false : true,
        attribution_basis: alreadyClient ? "prospect_said" : "reaction_to_our_email",
        detail: {
          subject: reply.subject ?? null,
          classification: verdict?.classification ?? null,
          proposalType: obj(obj(reply.judgments)?.proposalType)?.value ?? null,
          escalation: reply.escalation ?? null,
        },
      };
    }
    default:
      return "unplaced";
  }
}

async function outreachRows(
  orgId: string,
  brandId: string,
  offers: ReadonlyMap<string, string | null>,
): Promise<{ rows: TimelineFactRow[]; unjudged: number; unplaced: number; withdrawn: string[] }> {
  const facts = await readOutreachFacts(orgId, brandId);
  const leadByEmail = await readLeadEmails([...new Set(facts.map((f) => f.lead_email))]);
  let site: Promise<string[]> | null = null;
  const siteHosts: SiteHosts = (offerId) => {
    site ??= getBrandSite(brandId, orgId, offerId).then((b) =>
      [b.domain, b.clickDestinationUrl].map((v) => (v ? hostOf(v) : null)).filter((h): h is string => h !== null),
    );
    return site;
  };
  const rows: TimelineFactRow[] = [];
  const withdrawn: string[] = [];
  let unjudged = 0;
  let unplaced = 0;
  for (const fact of facts) {
    if (fact.type === "withdrawn") {
      withdrawn.push(fact.subject_key);
      continue;
    }
    const leadId = leadByEmail.get(fact.lead_email);
    if (!leadId) continue;
    const row = await outreachRow(orgId, brandId, fact, leadId, offers, siteHosts);
    if (row === "unjudged") unjudged++;
    else if (row === "unplaced") unplaced++;
    else rows.push(row);
  }
  return { rows, unjudged, unplaced, withdrawn };
}

/** Mark the rows of subjects the feed withdrew; their content stays as last stated. */
async function markWithdrawn(orgId: string, brandId: string, subjectKeys: readonly string[]): Promise<number> {
  if (subjectKeys.length === 0) return 0;
  const result = await sql`
    UPDATE lead_timeline_facts SET withdrawn_at = now(), updated_at = now()
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND withdrawn_at IS NULL
      AND id IN (SELECT jsonb_array_elements_text(${JSON.stringify(subjectKeys)}::jsonb))
  `;
  return result.count;
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
  outreach: number;
  unjudgedReplies: number;
  unplacedOutcomes: number;
  unplacedOutreach: number;
  written: number;
}

/** Re-read every source of one brand and write what changed. Throws when a source is unreadable. */
export async function syncTimelineFacts(orgId: string, brandId: string): Promise<TimelineSyncResult> {
  const offers = await fetchOrgCampaignOffers({ orgId });
  const outcomes = outcomeRows(orgId, brandId, await readOutcomes(orgId, brandId), offers);
  const nevers = neverRows(orgId, brandId, await readNevers(orgId, brandId), offers);
  const { caughtUp } = await loadOutreachFeedState();
  if (!caughtUp) {
    throw new Error("the outreach fact copy has not reached the end of the feed yet; refusing to read it partial");
  }
  const outreach = await outreachRows(orgId, brandId, offers);
  const written =
    (await upsertTimelineFacts([...outcomes.rows, ...nevers, ...outreach.rows])) +
    (await markWithdrawn(orgId, brandId, outreach.withdrawn));
  return {
    outcomes: outcomes.rows.length,
    nevers: nevers.length,
    outreach: outreach.rows.length,
    unjudgedReplies: outreach.unjudged,
    unplacedOutcomes: outcomes.unplaced,
    unplacedOutreach: outreach.unplaced,
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
        if (r.written > 0 || r.unplacedOutcomes > 0 || r.unplacedOutreach > 0) {
          console.log(
            `[lead-service] timeline brand=${brand_id} outcomes=${r.outcomes} nevers=${r.nevers} ` +
              `outreach=${r.outreach} unjudged=${r.unjudgedReplies} unplaced=${r.unplacedOutcomes}/${r.unplacedOutreach} written=${r.written}`,
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
