import { sql } from "../db/index.js";
import { resolveAudiencesForBrand, resolveBrandMembershipsByEmail, type BrandMembership } from "./audience-client.js";
import { toIsoTimestamp, type RawTimestamp } from "./basic-leads.js";
import { readBuyingSignal } from "./buying-signal.js";
import { fetchOrgCampaignRows } from "./campaign-identity-client.js";
import { SOURCE_LEG_KEY } from "./source-campaign.js";
import { SOURCE_FOUND_STATUS_REASON } from "./source-stock.js";
import { loadOriginBySlug } from "./sourcing-origin.js";
import {
  computeSourcePeople,
  type SourceCheckDeclineRow,
  type SourcePeopleResult,
  type SourceScreeningRow,
  type SourceServeRow,
} from "./source-people.js";

/**
 * IO for `GET /orgs/campaigns/{campaignId}/sourcing-stats` (the pure derivation is source-people.ts).
 *
 * Asks, in order: campaign-service which source this campaign is (offer, origin slug, brand) and
 * which campaigns of the offer do outreach; features-service which audience LIST KINDS the origin
 * counts; our own rows (every lead row of the brand, every candidate screened for it, every
 * must-pass decline); human-service every audience that found each of the brand's people (by email);
 * human-service the audiences' names. Any of them unreadable fails the read (never a partial count).
 */

export class SourceCampaignNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceCampaignNotFoundError";
  }
}

export class NotASourceCampaignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotASourceCampaignError";
  }
}

const MEMBERSHIP_EMAILS_PER_CALL = 1000;
const MEMBERSHIP_CALLS_IN_FLIGHT = 4;

export interface SourcingStats extends SourcePeopleResult {
  campaignId: string;
  brandId: string;
  offerId: string;
  origin: { slug: string; name: string; lists: string[] };
  outreachCampaignIds: string[];
  byAudience: Array<SourcePeopleResult["byAudience"][number] & { name: string | null }>;
}

interface RawServe {
  lead_id: string;
  campaign_id: string;
  audience_id: string | null;
  status: string;
  status_reason: string | null;
  source_handed: boolean;
  source_set_aside_reason: string | null;
  at: RawTimestamp;
  buying_signal: unknown;
  apollo_person_id: string | null;
  emails: string[] | null;
  primary_domain: string | null;
  org_name: string | null;
}

async function loadBrandServes(orgId: string, brandId: string): Promise<SourceServeRow[]> {
  const out: SourceServeRow[] = [];
  const query = sql<RawServe[]>`
    SELECT lc.lead_id, lc.campaign_id, lc.audience_id, lc.status, lc.status_reason,
           lc.source_handed_at IS NOT NULL AS source_handed, lc.source_set_aside_reason,
           COALESCE(lc.served_at, lc.created_at) AS at, lc.buying_signal, l.apollo_person_id,
           (SELECT array_agg(cm.value ORDER BY cm.value) FROM lead_contact_methods cm
             WHERE cm.lead_id = lc.lead_id AND cm.channel = 'email') AS emails,
           org.primary_domain, org.org_name
    FROM leads_campaigns lc
    LEFT JOIN leads l ON l.id = lc.lead_id
    LEFT JOIN LATERAL (
      SELECT o.name AS org_name, o.primary_domain
      FROM leads_organizations lo
      LEFT JOIN organizations o ON o.id = lo.organization_id
      WHERE lo.lead_id = lc.lead_id AND lo.current = true
      ORDER BY (CASE WHEN o.logo_url IS NOT NULL OR o.primary_domain IS NOT NULL THEN 1 ELSE 0 END) DESC,
               lo.created_at DESC NULLS LAST,
               lo.organization_id ASC
      LIMIT 1
    ) org ON true
    WHERE lc.org_id = ${orgId} AND ${brandId} = ANY(lc.brand_ids)
  `;
  for await (const rows of query.cursor(1000)) {
    for (const r of rows) {
      out.push({
        leadId: r.lead_id,
        campaignId: r.campaign_id,
        audienceId: r.audience_id,
        status: r.status,
        at: toIsoTimestamp(r.at) as string,
        buyingSignal: readBuyingSignal(r.buying_signal),
        apolloPersonId: r.apollo_person_id,
        emails: r.emails ?? [],
        companyDomain: r.primary_domain,
        companyName: r.org_name,
        sourceFound: r.status_reason === SOURCE_FOUND_STATUS_REASON,
        sourceHanded: r.source_handed === true,
        setAsideReason: r.source_set_aside_reason,
      });
    }
  }
  return out;
}

async function loadScreenings(orgId: string, brandId: string): Promise<SourceScreeningRow[]> {
  const rows = await sql<
    Array<{ audience_id: string; provider_person_id: string; verdict: string; created_at: RawTimestamp; company_domain: string | null; company_name: string | null }>
  >`
    SELECT audience_id, provider_person_id, verdict, created_at, company_domain, company_name
    FROM candidate_screenings
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
  `;
  return rows.map((r) => ({
    audienceId: r.audience_id,
    providerPersonId: r.provider_person_id,
    verdict: r.verdict,
    at: toIsoTimestamp(r.created_at) as string,
    companyDomain: r.company_domain,
    companyName: r.company_name,
  }));
}

async function loadCheckDeclines(orgId: string, brandId: string, offerId: string): Promise<SourceCheckDeclineRow[]> {
  const rows = await sql<Array<{ audience_id: string | null; provider_person_id: string | null; checked_at: RawTimestamp; domain: string | null }>>`
    SELECT substring(qc.subject from '^candidate:([^:]+):') AS audience_id,
           substring(qc.subject from '^candidate:[^:]+:(.+)$') AS provider_person_id,
           qc.checked_at, qc.domain
    FROM qualification_checks qc
    JOIN qualification_verdicts v ON v.id = qc.verdict_id
    WHERE qc.org_id = ${orgId} AND qc.brand_id = ${brandId} AND qc.offer_id = ${offerId}
      AND qc.subject LIKE 'candidate:%' AND v.verdict = 'no'
  `;
  return rows
    .filter((r) => r.audience_id && r.provider_person_id)
    .map((r) => ({
      audienceId: r.audience_id as string,
      providerPersonId: r.provider_person_id as string,
      at: toIsoTimestamp(r.checked_at) as string,
      domain: r.domain,
    }));
}

async function loadMemberships(brandId: string, emails: string[], orgId: string): Promise<Map<string, BrandMembership[]>> {
  const out = new Map<string, BrandMembership[]>();
  const chunks: string[][] = [];
  for (let i = 0; i < emails.length; i += MEMBERSHIP_EMAILS_PER_CALL) chunks.push(emails.slice(i, i + MEMBERSHIP_EMAILS_PER_CALL));
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const chunk = chunks[next++];
      const got = await resolveBrandMembershipsByEmail(brandId, chunk, { orgId });
      for (const [email, ms] of got) out.set(email, ms);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MEMBERSHIP_CALLS_IN_FLIGHT, chunks.length) }, worker));
  return out;
}

export async function readSourcingStats(campaignId: string, ctx: { orgId: string; userId?: string | null; runId?: string | null }): Promise<SourcingStats> {
  const campaigns = await fetchOrgCampaignRows(ctx);
  const source = campaigns.find((c) => c.id === campaignId);
  if (!source) throw new SourceCampaignNotFoundError(`campaign ${campaignId} is not a campaign of this org`);
  const brandId = source.brandId ?? source.brandIds?.[0] ?? null;
  if (source.legKey !== SOURCE_LEG_KEY || !source.offerId || !source.featureSlug || !brandId) {
    throw new NotASourceCampaignError(
      `campaign ${campaignId} is not a lead source (leg ${source.legKey ?? "none"}, offer ${source.offerId ?? "none"}, origin ${source.featureSlug ?? "none"}, brand ${brandId ?? "none"})`,
    );
  }
  const offerId = source.offerId;
  const origin = await loadOriginBySlug(source.featureSlug);
  if (!origin) throw new NotASourceCampaignError(`campaign ${campaignId} names origin ${source.featureSlug}, which the sourcing catalogue does not list`);

  const outreachCampaignIds = campaigns
    .filter((c) => c.offerId === offerId && (c.brandId ?? c.brandIds?.[0]) === brandId && c.legKey !== SOURCE_LEG_KEY)
    .map((c) => c.id)
    .sort();

  const [serves, screenings, checkDeclines] = await Promise.all([
    loadBrandServes(ctx.orgId, brandId),
    loadScreenings(ctx.orgId, brandId),
    loadCheckDeclines(ctx.orgId, brandId, offerId),
  ]);
  const emails = [...new Set(serves.flatMap((s) => s.emails))].sort();
  const membershipsByEmail = await loadMemberships(brandId, emails, ctx.orgId);

  const result = computeSourcePeople({
    offerId,
    lists: new Set(origin.lists),
    outreachCampaignIds: new Set(outreachCampaignIds),
    serves,
    membershipsByEmail,
    screenings,
    checkDeclines,
  });

  const audienceIds = result.byAudience.map((a) => a.audienceId);
  const cards = audienceIds.length
    ? (await resolveAudiencesForBrand(brandId, { audienceIds, emails: [] }, { orgId: ctx.orgId })).byAudienceId
    : {};

  return {
    campaignId,
    brandId,
    offerId,
    origin: { slug: origin.slug, name: origin.name, lists: origin.lists },
    outreachCampaignIds,
    ...result,
    byAudience: result.byAudience.map((a) => ({ ...a, name: cards[a.audienceId]?.name ?? null })),
  };
}
