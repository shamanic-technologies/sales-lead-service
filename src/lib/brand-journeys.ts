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
}

export interface JourneyAct {
  campaignId: string | null;
  kind: "email" | "followup";
  firstAt: string | null;
  lastAt: string | null;
  count: number;
}

export interface BrandJourney {
  leadId: string;
  offerId: string | null;
  firstActedAt: string | null;
  facts: JourneyFact[];
  acts: JourneyAct[];
}

interface RawJourney {
  lead_id: string;
  offer_id: string | null;
  first_acted_at: RawTimestamp;
  facts: Array<Record<string, unknown>> | null;
  acts: Array<Record<string, unknown>> | null;
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
    })),
    acts: (r.acts ?? []).map((a) => ({
      campaignId: (a.campaignId as string | null) ?? null,
      kind: a.kind as "email" | "followup",
      firstAt: iso(a.firstAt),
      lastAt: iso(a.lastAt),
      count: Number(a.count),
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
    f AS (
      SELECT * FROM lead_timeline_facts
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND withdrawn_at IS NULL
    ),
    facts AS (
      SELECT lead_id, offer_id,
        jsonb_agg(jsonb_build_object(
          'id', id, 'label', label, 'source', source, 'occurredAt', occurred_at,
          'campaignId', campaign_id, 'attributable', attributable, 'attributionBasis', attribution_basis,
          'valueCents', detail->'valueCents', 'url', url
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
    )
    SELECT COALESCE(facts.lead_id, acts.lead_id)::text AS lead_id,
      CASE WHEN facts.lead_id IS NOT NULL THEN facts.offer_id ELSE acts.offer_id END AS offer_id,
      acts.first_acted_at, facts.facts, acts.acts
    FROM facts
    FULL JOIN acts ON acts.lead_id = facts.lead_id AND COALESCE(acts.offer_id, '') = COALESCE(facts.offer_id, '')
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
