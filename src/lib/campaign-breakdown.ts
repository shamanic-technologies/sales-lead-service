/**
 * A person's campaigns, each stating what happened IN THAT CAMPAIGN.
 *
 * A brand-scoped `GET /orgs/leads` answers one row per PERSON (the membership rows collapse, see
 * lead-list-query.ts) and stamps the BRAND's delivery roll-up on it. That is the right answer to
 * "did this brand reach this person", and the wrong one to "did this campaign reach them": 56,809
 * people in production sit in more than one campaign of one brand, one of them in 11 campaign
 * identities across 9 offers, so a panel nesting campaign cards under the person would print
 * byte-identical evidence under every card.
 *
 * This module answers the second question without touching the first. The brand-wide fields stay
 * exactly where they are on the row; the nested cards are read out of the per-campaign breakdown
 * email-gateway ALREADY returns in brand mode (`byCampaign`) and which this service used to
 * collapse and discard. So no new network call is made for them.
 *
 * Three rules it keeps:
 *
 *   - A card is one campaign IDENTITY, not one stored campaign row — the same grouping every
 *     campaign-scoped read already totals (campaign-identity.ts), so a person served under a
 *     stopped ancestor of a live campaign reads on the card of the campaign the customer knows.
 *   - Evidence the provider does not hold for a campaign is `delivery: null`, never an all-false
 *     status. "We cannot tell" and "no" are different facts and a nested card must not print the
 *     second where only the first is known.
 *   - The brand-contacted widening the campaign-scoped flatten applies is NOT applied here (see
 *     flattenCampaignSubsetStatus) — it would restamp brand-wide evidence onto every card, which
 *     is the bug being fixed.
 */
import { sql } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { fetchOrgCampaignFamilies } from "./campaign-identity-client.js";
import type { CampaignFamilies } from "./campaign-identity.js";
import { flattenCampaignSubsetStatus, type FlattenedStatus } from "./delivery-flatten.js";
import type { StatusResult } from "./email-gateway-client.js";
import { campaignScopeIds, leadStatusScope, type LeadListScope } from "./lead-list-query.js";
import {
  createLeadStandingResolver,
  type ResolvedLeadFacts,
} from "./lead-standing-resolver.js";
import type { LeadStanding } from "./lead-standing.js";
import type { OfferCard, OfferCardResolver } from "./offer-card-client.js";

/** One campaign card under a person: what that campaign is, and what happened in it. */
export interface LeadCampaignEvidence {
  /** The `leads_campaigns` row this card speaks for — addressable at GET /orgs/leads/{id}. */
  id: string;
  /** The campaign row that membership names. */
  campaignId: string;
  /**
   * Every stored campaign id whose evidence this card reads — the identity's members, restricted
   * to the read's own campaign scope when it has one. `[campaignId]` when the identity could not
   * be resolved, which is the pre-identity behaviour and never a partial family.
   */
  campaignIds: string[];
  status: string;
  servedAt: string | null;
  audienceId: string | null;
  offer: OfferCard | null;
  /** Where this person stands ON THIS CAMPAIGN, resolved exactly as the row-level standing is. */
  standing: LeadStanding;
  /**
   * The delivery evidence for THIS campaign alone, or null when the provider reports none for it.
   * Null is "we cannot tell", not "nothing happened" — see the module header.
   */
  delivery: FlattenedStatus | null;
}

export interface CampaignBreakdownResolver {
  /**
   * The campaign cards for each of `rows`, keyed by `leads_campaigns.id` (the row the list emits),
   * so a caller attaches them to the row it already holds.
   */
  resolve(
    rows: readonly BreakdownRequestRow[],
    statusByEmail: ReadonlyMap<string, StatusResult>,
  ): Promise<Map<string, LeadCampaignEvidence[]>>;
}

/** What the caller already holds per emitted row. */
export interface BreakdownRequestRow {
  /** `leads_campaigns.id` of the emitted row — the key the cards come back under. */
  id: string;
  leadId: string;
  email: string | null;
  /**
   * The row's own delivery overlay, used ONLY when the read is scoped to a single campaign: the
   * gateway was then asked in campaign mode, which returns no `byCampaign` breakdown, and the row's
   * evidence already IS that campaign's. Nothing about that call changes for the breakdown.
   */
  delivery?: FlattenedStatus | null;
}

export interface CampaignBreakdownOptions {
  scope: LeadListScope;
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  brandId?: string | null;
  /** Whether the delivery layer was asked at all for this read. */
  deliveryQueried: boolean;
  /** Reused so a card names the offer the same way, resolved by the same two calls, as the row. */
  offerResolver: OfferCardResolver;
  /**
   * The one campaign id the read is scoped to, when it is scoped to exactly one — the case where
   * email-gateway was asked in campaign mode and serves no per-campaign breakdown. The single card
   * then carries the row's own evidence, which is that campaign's by construction. Null for every
   * brand / org / offer / multi-member-identity read, which is where the breakdown is read.
   */
  singleCampaignScopeId?: string | null;
}

interface MembershipRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  status: string;
  served_at: Date | string | null;
  audience_id: string | null;
  created_at: Date | string;
  brand_ids: string[];
}

/** Most-advanced lifecycle first — the same winner ordering the deduped list read uses. */
const STATUS_RANK: Record<string, number> = { served: 3, claimed: 2, buffered: 1, skipped: 0 };

function betterMembership(a: MembershipRow, b: MembershipRow): MembershipRow {
  const ra = STATUS_RANK[a.status] ?? -1;
  const rb = STATUS_RANK[b.status] ?? -1;
  if (ra !== rb) return ra > rb ? a : b;
  const sa = toIsoTimestamp(a.served_at) ?? "";
  const sb = toIsoTimestamp(b.served_at) ?? "";
  if (sa !== sb) return sa > sb ? a : b;
  const ca = toIsoTimestamp(a.created_at) ?? "";
  const cb = toIsoTimestamp(b.created_at) ?? "";
  if (ca !== cb) return ca > cb ? a : b;
  return a.id <= b.id ? a : b;
}

/**
 * Every membership row of these people that is IN the read's scope.
 *
 * Same brand / campaign / lifecycle predicates the list itself applies, so a card can never appear
 * for a campaign the caller's scope excludes, and a `?status=` narrowing means the same thing here
 * as it does there.
 */
async function fetchMemberships(
  scope: LeadListScope,
  leadIds: string[],
): Promise<MembershipRow[]> {
  if (leadIds.length === 0) return [];
  const campaignIds = campaignScopeIds(scope);
  const statuses = leadStatusScope(scope);
  return await sql<MembershipRow[]>`
    SELECT lc.id, lc.lead_id, lc.campaign_id, lc.status, lc.served_at, lc.audience_id,
           lc.created_at, lc.brand_ids
    FROM leads_campaigns lc
    WHERE lc.org_id = ${scope.orgId}
      AND lc.lead_id = ANY(${leadIds}::uuid[])
      ${scope.brandId ? sql`AND ${scope.brandId} = ANY(lc.brand_ids)` : sql``}
      ${campaignIds ? sql`AND lc.campaign_id = ANY(${campaignIds})` : sql``}
      ${statuses ? sql`AND lc.status = ANY(${statuses})` : sql``}
      ${scope.queryOrgId ? sql`AND lc.org_id = ${scope.queryOrgId}` : sql``}
      ${scope.userId ? sql`AND lc.user_id = ${scope.userId}` : sql``}
      ${scope.workflowSlug ? sql`AND lc.workflow_slug = ${scope.workflowSlug}` : sql``}
    ORDER BY lc.created_at ASC, lc.id ASC
  `;
}

/**
 * FAIL-SOFT, loudly: with campaign-service unreachable every campaign is its own identity, which
 * is this service's pre-identity behaviour and the one degradation that invents nothing. It never
 * pools two campaigns on a guess and never widens a card to the brand.
 */
async function loadFamilies(options: CampaignBreakdownOptions): Promise<CampaignFamilies | null> {
  try {
    return await fetchOrgCampaignFamilies({
      orgId: options.orgId,
      userId: options.userId ?? null,
      runId: options.runId ?? null,
      brandId: options.brandId ?? null,
    });
  } catch (error) {
    console.error(
      `[lead-service] campaign identities unavailable for orgId=${options.orgId} — every campaign ` +
        `card is one stored campaign row rather than one identity (a person served under a stopped ` +
        `ancestor reads on its own card): ${(error as Error).message}`,
    );
    return null;
  }
}

export function createCampaignBreakdownResolver(
  options: CampaignBreakdownOptions,
): CampaignBreakdownResolver {
  const { scope, offerResolver, deliveryQueried } = options;
  const standingCtx = {
    orgId: options.orgId,
    userId: options.userId ?? null,
    runId: options.runId ?? null,
    brandId: options.brandId ?? null,
  };
  // Two resolvers, because a card whose delivery the provider cannot speak to must not read as
  // "never contacted": it is resolved with the delivery layer marked unasked, which answers
  // `unresolved` / `delivery_not_queried` unless a hand statement decides it on its own.
  const measuredStanding = createLeadStandingResolver({ ...standingCtx, deliveryQueried });
  const unmeasuredStanding = createLeadStandingResolver({ ...standingCtx, deliveryQueried: false });
  // The org's campaign identities, read ONCE for the whole response and reused by every chunk.
  let families: Promise<CampaignFamilies | null> | null = null;

  const scopeIds = campaignScopeIds(scope);
  const scopeIdSet = scopeIds ? new Set(scopeIds) : null;

  return {
    async resolve(rows, statusByEmail) {
      const out = new Map<string, LeadCampaignEvidence[]>();
      if (rows.length === 0) return out;

      if (!families) families = loadFamilies(options);
      const resolvedFamilies = await families;

      const leadIds = Array.from(new Set(rows.map((r) => r.leadId).filter(Boolean)));
      const memberships = await fetchMemberships(scope, leadIds);

      const byLead = new Map<string, MembershipRow[]>();
      for (const m of memberships) {
        const list = byLead.get(m.lead_id);
        if (list) list.push(m);
        else byLead.set(m.lead_id, [m]);
      }

      // Group each person's memberships into identities, and pick the row each card speaks for.
      interface PendingCard {
        rowId: string;
        membership: MembershipRow;
        campaignIds: string[];
        delivery: FlattenedStatus | null;
      }
      const pending: PendingCard[] = [];
      const cardsByRow = new Map<string, PendingCard[]>();

      for (const row of rows) {
        const own = byLead.get(row.leadId) ?? [];
        const groups = new Map<string, MembershipRow[]>();
        for (const m of own) {
          const key =
            resolvedFamilies?.byCampaignId.get(m.campaign_id)?.key ?? `campaign:${m.campaign_id}`;
          const list = groups.get(key);
          if (list) list.push(m);
          else groups.set(key, [m]);
        }

        const statusResult = row.email ? statusByEmail.get(row.email) : undefined;
        const cards: PendingCard[] = [];
        for (const members of groups.values()) {
          const winner = members.reduce(betterMembership);
          // The identity's full membership — including campaign rows this person was never served
          // under, because email-gateway keys evidence on the campaign that SENT and a stopped
          // ancestor is where an old serve's evidence lives. Restricted to the read's own campaign
          // scope when it has one, so a scoped read can never read outside it.
          const familyIds = (
            resolvedFamilies?.familyOf(winner.campaign_id) ?? [winner.campaign_id]
          ).filter((id) => !scopeIdSet || scopeIdSet.has(id));
          const ids = familyIds.length > 0 ? familyIds : [winner.campaign_id];
          const delivery = options.singleCampaignScopeId
            ? (row.delivery ?? null)
            : statusResult
              ? flattenCampaignSubsetStatus(statusResult, new Set(ids))
              : null;
          cards.push({ rowId: row.id, membership: winner, campaignIds: ids, delivery });
        }
        cards.sort((a, b) =>
          (toIsoTimestamp(a.membership.created_at) ?? "") <
          (toIsoTimestamp(b.membership.created_at) ?? "")
            ? -1
            : 1,
        );
        cardsByRow.set(row.id, cards);
        pending.push(...cards);
      }

      if (pending.length === 0) {
        for (const row of rows) out.set(row.id, []);
        return out;
      }

      const offerMap = await offerResolver.resolve(pending.map((c) => c.membership.campaign_id));

      const standingRowOf = (c: PendingCard) => ({
        id: c.membership.id,
        leadId: c.membership.lead_id,
        campaignId: c.membership.campaign_id,
        brandIds: c.membership.brand_ids ?? [],
        status: c.membership.status,
        delivery: {
          contacted: !!c.delivery?.contacted,
          opened: !!c.delivery?.opened,
          clicked: !!c.delivery?.clicked,
          replied: !!c.delivery?.replied,
          replyClassification: c.delivery?.replyClassification ?? null,
          disqualified: c.delivery?.disqualified,
          bounced: !!c.delivery?.bounced,
          unsubscribed: !!c.delivery?.unsubscribed,
          globalBounced: !!c.delivery?.global.bounced,
          globalUnsubscribed: !!c.delivery?.global.unsubscribed,
        },
      });

      const measured = pending.filter((c) => c.delivery !== null);
      const unmeasured = pending.filter((c) => c.delivery === null);
      const [measuredMap, unmeasuredMap] = await Promise.all([
        measured.length > 0
          ? measuredStanding.resolve(measured.map(standingRowOf))
          : Promise.resolve(new Map<string, ResolvedLeadFacts>()),
        unmeasured.length > 0
          ? unmeasuredStanding.resolve(unmeasured.map(standingRowOf))
          : Promise.resolve(new Map<string, ResolvedLeadFacts>()),
      ]);

      for (const row of rows) {
        out.set(
          row.id,
          (cardsByRow.get(row.id) ?? []).map((c) => ({
            id: c.membership.id,
            campaignId: c.membership.campaign_id,
            campaignIds: c.campaignIds,
            status: c.membership.status,
            servedAt: toIsoTimestamp(c.membership.served_at),
            audienceId: c.membership.audience_id,
            offer: offerMap.get(c.membership.campaign_id) ?? null,
            standing:
              (c.delivery !== null
                ? measuredMap.get(c.membership.id)?.standing
                : unmeasuredMap.get(c.membership.id)?.standing) ?? UNRESOLVED_STANDING,
            delivery: c.delivery,
          })),
        );
      }

      return out;
    },
  };
}

/** What a card reads as when its standing could not be resolved at all. Never a plausible default. */
const UNRESOLVED_STANDING: LeadStanding = {
  state: "unresolved",
  signal: "none",
  origin: null,
  reason: "statements_unreadable",
  legKey: null,
  entryStep: null,
  entryMeasure: null,
  reachedEntryStep: null,
  deepestStep: null,
  at: null,
  wentCold: null,
};
