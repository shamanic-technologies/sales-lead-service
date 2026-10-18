import { sql } from "../db/index.js";
import { toIsoTimestamp, type RawTimestamp } from "./basic-leads.js";

/**
 * EVERY JOURNEY of a brand, read off the silver timeline (`lead_timeline_facts`) in one statement:
 * one row per person x offer (offer `null` = facts about the person at the brand, stated on no
 * offer; the consumer decides what to do with them, nothing is copied onto every offer here).
 *
 * Consumer: features-service derives the sales path each person actually lived, splits each
 * campaign's spend across the people it acted on, and sums revenue on paid clients.
 *
 * Two halves per journey, both LIVE only (a withdrawn fact is a fact taken back: absent here):
 *   - `facts`: every timeline fact that is NOT one of our emails (step reached, reply, open, click,
 *     unsubscribe, outcome...), with its label VERBATIM. Labels are never filtered against a
 *     vocabulary: a label this service does not know yet (e.g. `industry_update_video` written by a
 *     future source) is served like any other.
 *   - `acts`: the campaigns that ACTED on the person, compacted per (campaign, kind): our emails
 *     (`kind: "email"`, every fact whose attribution basis is `our_email`: sends and bounces) and the
 *     follow-up ledger's `acted` rows (`kind: "followup"`, the acting campaign, offer read from
 *     campaign-service). Each act states first/last instant and how many times. Sends are the bulk of
 *     the table (~90%), so they are counted, never listed.
 *   - `emailSends` (WORKFLOW-SEND-HISTORY-1016): our SENDS only (`initial_email`, `followup`; never a
 *     bounce), compacted per (campaign, WORKFLOW that sent): every campaign x workflow under which the
 *     person was actually emailed, first/last send and count. A send's workflow = the run holding the
 *     person's `leads_campaigns` row of that campaign WHEN it was sent: the latest re-point at or before
 *     the send (`lead_campaign_run_repoints`: a retry-pool claim or a named serve hands the paid person
 *     to another run, maybe another workflow, which is the one that sends), else the row's own serve
 *     (`workflow_slug`). `workflowSource` says which; both null when the person holds no row under that
 *     campaign (nothing local names the sender's workflow; never guessed from another row).
 *   - TRANSPORT (SCOUT-VISIT-SCREEN-1018): every outreach fact names the path it went through, verbatim off
 *     the current outreach fact of its subject (`outreach_facts.raw->>'transport'`: `smtp` = sent by US, our
 *     tracker; `instantly` = the provider). A fact states it as `transport`; a CLICK also states `screened`:
 *     true iff our tracker recorded it (`smtp`: only a hit instantly-service judged human is promoted, a
 *     scanner's is withdrawn), false when the provider reported it (no verdict, mostly link scanners), null on
 *     every fact that is not a click. Each `emailSends` entry splits its sends by transport (`transports`), so
 *     a consumer keeps only people emailed through our own path in a visit denominator. A fact no outreach
 *     fact names (CRM, by hand) = null, never guessed.
 *
 * Aggregated in Postgres (~0.4 s on the largest brand, 63k facts / 17.5k journeys) and streamed
 * through a server-side cursor: the response never holds the population.
 */
export interface JourneyFact {
  id: string;
  label: string;
  source: string;
  occurredAt: string | null;
  campaignId: string | null;
  attributable: boolean | null;
  attributionBasis: string | null;
  /** The stated amount on an outcome (a sale), cents; null when none was stated or not an outcome. */
  valueCents: number | null;
  url: string | null;
  /** The outreach path the fact went through, verbatim (`smtp` ours, `instantly` the provider); null = not an outreach fact. */
  transport: string | null;
  /** Clicks only: true = our tracker recorded it (judged human), false = the provider reported it (unscreened); null otherwise. */
  screened: boolean | null;
}

export interface JourneyAct {
  campaignId: string | null;
  kind: "email" | "followup";
  firstAt: string | null;
  lastAt: string | null;
  count: number;
}

/** Which record named the sending workflow: the row's serve, or a re-point of the row to the sending run. */
export type EmailSendWorkflowSource = "serve" | "retry_claim" | "named_serve";

export interface JourneyEmailSendTransport {
  /** Verbatim outreach transport (`smtp` ours, `instantly` the provider); null = no outreach fact names it. */
  transport: string | null;
  firstSentAt: string | null;
  lastSentAt: string | null;
  count: number;
}

export interface JourneyEmailSend {
  campaignId: string | null;
  /** The workflow of the run that sent; null = no record names it (see `workflowSource`). */
  workflowSlug: string | null;
  /** null = the person holds no serve row under this campaign. */
  workflowSource: EmailSendWorkflowSource | null;
  firstSentAt: string | null;
  lastSentAt: string | null;
  count: number;
  /** The same sends split by transport (counts sum to `count`), earliest first. */
  transports: JourneyEmailSendTransport[];
}

export interface BrandJourney {
  leadId: string;
  offerId: string | null;
  firstActedAt: string | null;
  facts: JourneyFact[];
  acts: JourneyAct[];
  emailSends: JourneyEmailSend[];
}

/** The timeline labels of OUR sends (bounces share the `our_email` basis but are not sends). */
export const EMAIL_SEND_LABELS = ["initial_email", "followup"] as const;

interface RawJourney {
  lead_id: string;
  offer_id: string | null;
  first_acted_at: RawTimestamp;
  facts: Array<Record<string, unknown>> | null;
  acts: Array<Record<string, unknown>> | null;
  email_sends: Array<Record<string, unknown>> | null;
}

function workflowSource(v: unknown): EmailSendWorkflowSource | null {
  if (v === null || v === undefined) return null;
  if (v === "serve" || v === "retry_claim" || v === "named_serve") return v;
  throw new Error(`[lead-service] timeline-journeys: unknown email send workflow source ${JSON.stringify(v)}`);
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return toIsoTimestamp(v as string);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function toBrandJourney(r: RawJourney): BrandJourney {
  return {
    leadId: r.lead_id,
    offerId: r.offer_id,
    firstActedAt: toIsoTimestamp(r.first_acted_at),
    facts: (r.facts ?? []).map((f) => ({
      id: f.id as string,
      label: f.label as string,
      source: f.source as string,
      occurredAt: iso(f.occurredAt),
      campaignId: (f.campaignId as string | null) ?? null,
      attributable: (f.attributable as boolean | null) ?? null,
      attributionBasis: (f.attributionBasis as string | null) ?? null,
      valueCents: num(f.valueCents),
      url: (f.url as string | null) ?? null,
      transport: (f.transport as string | null) ?? null,
      screened: (f.screened as boolean | null) ?? null,
    })),
    acts: (r.acts ?? []).map((a) => ({
      campaignId: (a.campaignId as string | null) ?? null,
      kind: a.kind as "email" | "followup",
      firstAt: iso(a.firstAt),
      lastAt: iso(a.lastAt),
      count: Number(a.count),
    })),
    emailSends: (r.email_sends ?? []).map((e) => ({
      campaignId: (e.campaignId as string | null) ?? null,
      workflowSlug: (e.workflowSlug as string | null) ?? null,
      workflowSource: workflowSource(e.workflowSource),
      firstSentAt: iso(e.firstAt),
      lastSentAt: iso(e.lastAt),
      count: Number(e.count),
      transports: ((e.transports as Array<Record<string, unknown>> | null) ?? []).map((t) => ({
        transport: (t.transport as string | null) ?? null,
        firstSentAt: iso(t.firstAt),
        lastSentAt: iso(t.lastAt),
        count: Number(t.count),
      })),
    })),
  };
}

/** campaign id -> offer id (null = the campaign states none), as campaign-service answers. */
function offersJson(offers: ReadonlyMap<string, string | null>): string {
  const o: Record<string, string | null> = {};
  for (const [k, v] of offers) o[k] = v;
  return JSON.stringify(o);
}

function journeyQuery(orgId: string, brandId: string, offers: ReadonlyMap<string, string | null>) {
  return sql<RawJourney[]>`
    WITH offers AS (
      SELECT key AS campaign_id, value #>> '{}' AS offer_id FROM jsonb_each(${offersJson(offers)}::jsonb)
    ),
    -- Each fact's outreach transport, off the current outreach fact of its subject (the timeline row's id).
    f AS (
      SELECT t.*, o.type AS outreach_type, o.raw->>'transport' AS transport
      FROM lead_timeline_facts t
      LEFT JOIN LATERAL (
        SELECT x.type, x.raw FROM outreach_facts x
        WHERE t.source IN ('outreach', 'reply') AND x.subject_key = t.id AND x.org_id = t.org_id AND x.type <> 'withdrawn'
        ORDER BY x.seq DESC
        LIMIT 1
      ) o ON true
      WHERE t.org_id = ${orgId} AND t.brand_id = ${brandId} AND t.withdrawn_at IS NULL
    ),
    facts AS (
      SELECT lead_id, offer_id,
        jsonb_agg(jsonb_build_object(
          'id', id, 'label', label, 'source', source, 'occurredAt', occurred_at,
          'campaignId', campaign_id, 'attributable', attributable, 'attributionBasis', attribution_basis,
          'valueCents', detail->'valueCents', 'url', url, 'transport', transport,
          'screened', CASE WHEN outreach_type = 'link_clicked' THEN transport IS NOT DISTINCT FROM 'smtp' END
        ) ORDER BY occurred_at ASC NULLS LAST, id ASC) AS facts
      FROM f WHERE attribution_basis IS DISTINCT FROM 'our_email'
      GROUP BY lead_id, offer_id
    ),
    act_rows AS (
      SELECT lead_id, offer_id, campaign_id, 'email'::text AS kind, occurred_at
      FROM f WHERE attribution_basis = 'our_email'
      UNION ALL
      SELECT fa.lead_id, o.offer_id, fa.acting_campaign_id, 'followup'::text, fa.occurred_at
      FROM followup_actions fa
      LEFT JOIN offers o ON o.campaign_id = fa.acting_campaign_id
      WHERE fa.org_id = ${orgId} AND ${brandId} = ANY(fa.brand_ids) AND fa.action = 'acted'
    ),
    acts AS (
      SELECT lead_id, offer_id,
        jsonb_agg(jsonb_build_object(
          'campaignId', campaign_id, 'kind', kind, 'firstAt', first_at, 'lastAt', last_at, 'count', n
        ) ORDER BY first_at ASC NULLS LAST, campaign_id ASC NULLS LAST, kind ASC) AS acts,
        min(first_at) AS first_acted_at
      FROM (
        SELECT lead_id, offer_id, campaign_id, kind, min(occurred_at) AS first_at,
          max(occurred_at) AS last_at, count(*)::int AS n
        FROM act_rows GROUP BY lead_id, offer_id, campaign_id, kind
      ) g
      GROUP BY lead_id, offer_id
    ),
    -- Each send credited to the run holding the person's row of its campaign when it went out.
    sends AS (
      SELECT f.lead_id, f.offer_id, f.campaign_id, f.occurred_at, f.transport,
        CASE WHEN lc.id IS NULL THEN NULL WHEN rp.cause IS NOT NULL THEN rp.workflow_slug ELSE lc.workflow_slug END AS workflow_slug,
        CASE WHEN lc.id IS NULL THEN NULL WHEN rp.cause IS NOT NULL THEN rp.cause ELSE 'serve' END AS workflow_source
      FROM f
      LEFT JOIN leads_campaigns lc
        ON lc.lead_id = f.lead_id AND lc.campaign_id = f.campaign_id AND lc.org_id = ${orgId}
      LEFT JOIN LATERAL (
        SELECT r.workflow_slug, r.cause FROM lead_campaign_run_repoints r
        WHERE r.lead_campaign_id = lc.id AND r.repointed_at <= f.occurred_at
        ORDER BY r.repointed_at DESC, r.id DESC
        LIMIT 1
      ) rp ON true
      WHERE f.attribution_basis = 'our_email' AND f.label IN ('initial_email', 'followup') -- EMAIL_SEND_LABELS
    ),
    email_sends AS (
      SELECT lead_id, offer_id,
        jsonb_agg(jsonb_build_object(
          'campaignId', campaign_id, 'workflowSlug', workflow_slug, 'workflowSource', workflow_source,
          'firstAt', first_at, 'lastAt', last_at, 'count', n, 'transports', transports
        ) ORDER BY first_at ASC NULLS LAST, campaign_id ASC NULLS LAST, workflow_slug ASC NULLS LAST) AS email_sends
      FROM (
        SELECT lead_id, offer_id, campaign_id, workflow_slug, workflow_source, min(first_at) AS first_at,
          max(last_at) AS last_at, sum(n)::int AS n,
          jsonb_agg(jsonb_build_object('transport', transport, 'firstAt', first_at, 'lastAt', last_at, 'count', n)
            ORDER BY first_at ASC NULLS LAST, transport ASC NULLS LAST) AS transports
        FROM (
          SELECT lead_id, offer_id, campaign_id, workflow_slug, workflow_source, transport, min(occurred_at) AS first_at,
            max(occurred_at) AS last_at, count(*)::int AS n
          FROM sends GROUP BY lead_id, offer_id, campaign_id, workflow_slug, workflow_source, transport
        ) gt
        GROUP BY lead_id, offer_id, campaign_id, workflow_slug, workflow_source
      ) g
      GROUP BY lead_id, offer_id
    )
    SELECT COALESCE(facts.lead_id, acts.lead_id)::text AS lead_id,
      CASE WHEN facts.lead_id IS NOT NULL THEN facts.offer_id ELSE acts.offer_id END AS offer_id,
      acts.first_acted_at, facts.facts, acts.acts, email_sends.email_sends
    FROM facts
    FULL JOIN acts ON acts.lead_id = facts.lead_id AND COALESCE(acts.offer_id, '') = COALESCE(facts.offer_id, '')
    LEFT JOIN email_sends ON email_sends.lead_id = acts.lead_id AND COALESCE(email_sends.offer_id, '') = COALESCE(acts.offer_id, '')
    ORDER BY 1 ASC, 2 ASC NULLS FIRST
  `;
}

/** Stream the brand's journeys in chunks of at most `chunkSize`, one statement. */
export async function* streamBrandJourneys(
  orgId: string,
  brandId: string,
  offers: ReadonlyMap<string, string | null>,
  chunkSize: number,
): AsyncGenerator<BrandJourney[]> {
  for await (const rows of journeyQuery(orgId, brandId, offers).cursor(Math.max(1, chunkSize))) {
    if (rows.length === 0) continue;
    yield rows.map(toBrandJourney);
  }
}
