import { Router } from "express";
import { type AuthenticatedRequest, apiKeyAuth, requireOrgId, getServiceContext } from "../middleware/auth.js";
import { sql } from "../db/index.js";
import {
  checkDeliveryStatus,
  type StatusResult,
  type DeliveryStatusItem,
  type ProviderStatus,
  type ScopedStatus,
  type GlobalStatus,
} from "../lib/email-gateway-client.js";
import { resolveCampaignFamily } from "../lib/campaign-identity-client.js";
import { resolveOfferCampaignIds, OfferCampaignsUnavailableError } from "../lib/offer-campaigns-client.js";
import {
  canonicalizeFunnelKey,
  FUNNEL_ENTRY,
  FUNNEL_KEYS,
  FUNNEL_STEPS,
  type FunnelKey,
} from "../lib/funnel-steps.js";
import { traceEvent } from "../lib/trace-event.js";
import { buildFullLeadsBatch, type FullLead } from "../lib/lead-shape.js";
import compression from "compression";
import { prefetchOne } from "../lib/prefetch.js";
import { toCompactLead } from "../lib/compact-lead.js";
import { crmPositiveReplyAtFor, fetchCrmPositiveReplyDates } from "../lib/crm-positive-reply-dates.js";
import { fetchBasicLeadChunk, streamBasicLeadChunks, toIsoTimestamp, type BasicLeadRow } from "../lib/basic-leads.js";
import {
  campaignScopeIds,
  encodeLeadCursor,
  leadCampaignBaseRelation,
  leadCursorTimestampParam,
  leadRowIdScope,
  leadStatusScope,
  parseLeadListPage,
  parseLeadStatusFilter,
  type LeadListCursor,
  type LeadListPage,
  type LeadListScope,
} from "../lib/lead-list-query.js";
import { parseLeadSearch } from "../lib/lead-search.js";
import { watchClient, isClientGone } from "../lib/client-abort.js";
import { ResponseWriter } from "../lib/stream-writer.js";
import { leadExportHeader, leadExportLine } from "../lib/lead-export.js";
import { parseLeadBucket, zeroBucketCounts, type LeadBucket } from "../lib/lead-buckets.js";
import { countLeadListRows } from "../lib/lead-index.js";
import { standingDelivery } from "../lib/lead-standing-index.js";
import { parseLeadSort, type LeadSortOrder } from "../lib/lead-page-plan.js";
import {
  ensureReadModel,
  noteEvidenceChanged,
  readModelBucketCounts,
  readModelDelivery,
  readModelPage,
  readModelScopeFor,
  readModelStandingAndStageCounts,
  readModelStandingCounts,
  ReadModelUnavailableError,
  type LeadPlanPage,
  type ReadModel,
} from "../lib/lead-read-model.js";
import {
  decodeFeedPosition,
  feedById,
  FeedPositionError,
  openChangeFeed,
  readChangeFeed,
  type ChangeFeed,
  type FeedPosition,
} from "../lib/lead-change-feed.js";
import { LeadEvidenceChangedRequestSchema } from "../schemas.js";
import { resolveAudiencesForBrand, type AudienceCard, type AudienceResolveContext } from "../lib/audience-client.js";
import { createOfferCardResolver, type OfferCard } from "../lib/offer-card-client.js";
import {
  createCampaignBreakdownResolver,
  type CampaignBreakdownResolver,
  type LeadCampaignEvidence,
} from "../lib/campaign-breakdown.js";
import {
  createLeadStandingResolver,
  type ResolvedLeadFacts,
  type LeadStandingResolver,
  type StandingRow,
} from "../lib/lead-standing-resolver.js";
import {
  parseLeadStandingFilter,
  parseSalesInterestStageFilter,
  SALES_INTEREST_STAGES,
  salesInterestStagesOf,
  zeroStandingCounts,
  type LeadStandingState,
  type SalesInterestStage,
} from "../lib/lead-standing.js";

const router = Router();
import {
  DEFAULT_STATUS,
  earliestIso,
  flattenBrandStatus,
  flattenCampaignStatus,
  flattenFamilyStatus,
  type FlattenedStatus,
} from "../lib/delivery-flatten.js";

// Re-exported: these used to live in this module and callers/tests may import them from here.
export { flattenBrandStatus, flattenCampaignStatus, flattenFamilyStatus };


// A single brand can carry 50k+ leads_campaigns rows. Loading every row before
// streaming still OOMs even if hydration/JSON writes are chunked. Read, hydrate,
// overlay delivery status, and serialize one chunk at a time so peak memory is
// bounded by LEADS_STREAM_CHUNK_SIZE regardless of the brand's lead count.
// The wire shape is byte-identical to the old res.json({ leads }) — `{"leads":[...]}`.
const LEADS_STREAM_CHUNK_SIZE = Math.max(1, Number(process.env.LEADS_STREAM_CHUNK_SIZE) || 500);

// postgres.js returns timestamptz as Date OR string depending on the path; the cursor carries
// whichever came back and normalizes at encode time (see LeadListCursor).
type LeadCampaignCursor = LeadListCursor;

interface RawLeadCampaignRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  org_id: string;
  user_id: string | null;
  brand_ids: string[];
  status: string;
  status_reason: string | null;
  status_details: string | null;
  parent_run_id: string | null;
  run_id: string | null;
  // postgres.js returns timestamptz as Date OR string depending on the path; normalize via toIsoTimestamp.
  served_at: Date | string | null;
  workflow_slug: string | null;
  feature_slug: string | null;
  goal: string | null;
  active_goal_id: string | null;
  brand_profile_id: string | null;
  audience_id: string | null;
  created_at: Date | string;
  // Full-precision text of the same column, for the keyset cursor (see LeadListCursor).
  created_at_cursor: string;
  lead_apollo_person_id: string | null;
}

interface LeadCampaignRow {
  id: string;
  leadId: string;
  campaignId: string;
  orgId: string;
  userId: string | null;
  brandIds: string[];
  status: string;
  statusReason: string | null;
  statusDetails: string | null;
  parentRunId: string | null;
  runId: string | null;
  servedAt: string | null;
  workflowSlug: string | null;
  featureSlug: string | null;
  goal: string | null;
  activeGoalId: string | null;
  brandProfileId: string | null;
  audienceId: string | null;
  createdAt: Date | string;
  /** `created_at::text` — what a cursor is built from; keeps the microseconds a Date drops. */
  cursorCreatedAt: string;
  leadApolloPersonId: string | null;
}

// Brand/org scope collapses leads_campaigns to one row per lead_id (see
// leadCampaignBaseRelation); campaign scope stays flat. Keyset-paginate the DEDUPED
// relation by (created_at, id) so dedup is GLOBAL, not per-chunk. Scope filters live
// both inside the dedup subquery (so the winner is chosen within scope) and on the
// outer WHERE (required for the non-deduped campaign path; a no-op for the dedup path).
/**
 * The ONE membership row a caller names, or null.
 *
 * Addressed by the row's own `id` — the identity every list row already carries as `id` — so the
 * caller needs nothing it did not get from the list. There is no dedup and no lifecycle filter
 * here: the caller is naming a row it has already been shown, not asking which of a person's rows
 * wins. `org_id` is the entitlement boundary and is part of the predicate rather than a check
 * afterwards, so a row belonging to another org is indistinguishable from one that does not exist.
 */
async function fetchLeadCampaignRowById(
  orgId: string,
  id: string,
): Promise<LeadCampaignRow | null> {
  const rows = await sql<RawLeadCampaignRow[]>`
    SELECT
      lc.id, lc.lead_id, lc.campaign_id, lc.org_id, lc.user_id, lc.brand_ids,
      lc.status, lc.status_reason, lc.status_details, lc.parent_run_id, lc.run_id,
      lc.served_at, lc.workflow_slug, lc.feature_slug, lc.goal, lc.active_goal_id,
      lc.brand_profile_id, lc.audience_id, lc.created_at,
      lc.created_at::text AS created_at_cursor,
      l.apollo_person_id AS lead_apollo_person_id
    FROM leads_campaigns lc
    LEFT JOIN leads l ON l.id = lc.lead_id
    WHERE lc.id = ${id} AND lc.org_id = ${orgId}
    LIMIT 1
  `;
  return mapLeadCampaignRows(rows)[0] ?? null;
}

/** Shared raw-row → camelCase mapping for both list and detail reads. */
function mapLeadCampaignRows(rows: RawLeadCampaignRow[]): LeadCampaignRow[] {
  return rows.map((r) => ({
    id: r.id,
    leadId: r.lead_id,
    campaignId: r.campaign_id,
    orgId: r.org_id,
    userId: r.user_id,
    brandIds: r.brand_ids,
    status: r.status,
    statusReason: r.status_reason,
    statusDetails: r.status_details,
    parentRunId: r.parent_run_id,
    runId: r.run_id,
    servedAt: toIsoTimestamp(r.served_at),
    workflowSlug: r.workflow_slug,
    featureSlug: r.feature_slug,
    goal: r.goal,
    activeGoalId: r.active_goal_id,
    brandProfileId: r.brand_profile_id,
    audienceId: r.audience_id,
    createdAt: r.created_at,
    cursorCreatedAt: r.created_at_cursor,
    leadApolloPersonId: r.lead_apollo_person_id,
  }));
}

async function fetchLeadCampaignChunk(
  scope: LeadListScope,
  cursor: LeadCampaignCursor | null,
  limit: number = LEADS_STREAM_CHUNK_SIZE,
  offset: number | null = null,
): Promise<LeadCampaignRow[]> {
  const rows = await sql<RawLeadCampaignRow[]>`
    SELECT
      lc.id, lc.lead_id, lc.campaign_id, lc.org_id, lc.user_id, lc.brand_ids,
      lc.status, lc.status_reason, lc.status_details, lc.parent_run_id, lc.run_id,
      lc.served_at, lc.workflow_slug, lc.feature_slug, lc.goal, lc.active_goal_id,
      lc.brand_profile_id, lc.audience_id, lc.created_at,
      lc.created_at::text AS created_at_cursor,
      l.apollo_person_id AS lead_apollo_person_id
    FROM ${leadCampaignBaseRelation(scope)}
    LEFT JOIN leads l ON l.id = lc.lead_id
    WHERE lc.org_id = ${scope.orgId}
      ${scope.brandId ? sql`AND ${scope.brandId} = ANY(lc.brand_ids)` : sql``}
      ${campaignScopeIds(scope) ? sql`AND lc.campaign_id = ANY(${campaignScopeIds(scope)!})` : sql``}
      ${leadStatusScope(scope) ? sql`AND lc.status = ANY(${leadStatusScope(scope)!})` : sql``}
      ${scope.queryOrgId ? sql`AND lc.org_id = ${scope.queryOrgId}` : sql``}
      ${scope.userId ? sql`AND lc.user_id = ${scope.userId}` : sql``}
      ${scope.workflowSlug ? sql`AND lc.workflow_slug = ${scope.workflowSlug}` : sql``}
      ${leadRowIdScope(scope) ? sql`AND lc.id = ANY(${leadRowIdScope(scope)!}::uuid[])` : sql``}
      ${cursor ? sql`AND (lc.created_at, lc.id) > (${leadCursorTimestampParam(cursor)}, ${cursor.id})` : sql``}
    ORDER BY lc.created_at ASC, lc.id ASC
    LIMIT ${limit}
    ${offset == null || offset === 0 ? sql`` : sql`OFFSET ${offset}`}
  `;

  return mapLeadCampaignRows(rows);
}

// Resolve each lead's ACTIVE audience for its brand, server-to-server via
// human-service. Runs per chunk (bounded set), grouped by the brand the audience
// must be correct for: the explicitly-scoped brandId when present (the dashboard
// leads page always scopes by brand), else the row's primary brand. Both keys the
// lead carries — its tagged audienceId (~5% of rows) AND its email (historical
// coverage) — are forwarded; human-service owns the brand-correct pick. Fail-loud:
// a resolver failure rejects and aborts the request (never a silently-blank field).
interface AudienceRowDescriptor {
  leadId: string;
  email: string | null;
  audienceId: string | null;
  brandIds: string[];
}

async function buildAudienceMapForRows(
  descriptors: AudienceRowDescriptor[],
  scopeBrandId: string | undefined,
  ctx: AudienceResolveContext,
): Promise<Map<string, AudienceCard>> {
  // Group rows by the brand the audience must be correct for: the explicitly-
  // scoped brandId when present, else the row's primary brand. human-service
  // resolves by DISTINCT audienceId + email arrays, so per group we send the
  // deduped key sets and correlate the two returned maps back onto each lead.
  const groups = new Map<string, AudienceRowDescriptor[]>();
  for (const d of descriptors) {
    const brandId = scopeBrandId ?? d.brandIds[0];
    if (!brandId) continue;
    if (!groups.has(brandId)) groups.set(brandId, []);
    groups.get(brandId)!.push(d);
  }

  const merged = new Map<string, AudienceCard>();
  await Promise.all(
    Array.from(groups.entries()).map(async ([brandId, rows]) => {
      const audienceIds = Array.from(
        new Set(rows.map((r) => r.audienceId).filter((x): x is string => !!x)),
      );
      const emails = Array.from(
        new Set(rows.map((r) => r.email).filter((x): x is string => !!x)),
      );

      const { byAudienceId, byEmail } = await resolveAudiencesForBrand(
        brandId,
        { audienceIds, emails },
        ctx,
      );

      for (const r of rows) {
        // Prefer the tagged audience's card; fall back to the email membership
        // when the tag is absent / not this brand / retired (null).
        const byTag = r.audienceId ? byAudienceId[r.audienceId] : null;
        const byMail = r.email ? byEmail[r.email] : null;
        const card = byTag ?? byMail ?? null;
        if (card) merged.set(r.leadId, card);
      }
    }),
  );
  return merged;
}

/**
 * The campaign id to ask email-gateway for: the single stored row when the scope is one campaign,
 * and NOTHING for a multi-member identity — brand mode is what returns the per-campaign breakdown
 * the identity is then read out of (see aggregateFamilyScope).
 */
function statusCampaignId(campaignIds: string[] | null): string | undefined {
  return campaignIds?.length === 1 ? campaignIds[0] : undefined;
}

async function buildStatusMapForBasicRows(
  rows: BasicLeadRow[],
  campaignId: string | undefined,
  context: ReturnType<typeof getServiceContext>,
) {
  const statusMap = new Map<string, StatusResult>();
  const groups = new Map<string, { brandId: string; items: DeliveryStatusItem[] }>();

  for (const row of rows) {
    if (row.status !== "served") continue;
    const email = row.email?.value;
    if (!email) continue;
    const primaryBrandId = row.brandIds[0] ?? "unknown";
    if (!groups.has(primaryBrandId)) {
      groups.set(primaryBrandId, { brandId: primaryBrandId, items: [] });
    }
    groups.get(primaryBrandId)!.items.push({ email });
  }

  await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      const response = await checkDeliveryStatus(group.brandId, campaignId, group.items, context);
      for (const result of response.results) statusMap.set(result.email, result);
    }),
  );

  return statusMap;
}

/**
 * One element of the list response, and the whole of the detail response.
 *
 * The two routes MUST emit the same object for the same row — a detail panel is rendered from
 * whichever of the two the consumer happened to read, so a field that exists on one and not the
 * other is a panel that changes shape depending on how it was loaded. Building it in one place is
 * what makes "the record carries everything the list carries" true by construction rather than by
 * review.
 */
function serializeLeadItem(
  row: LeadCampaignRow,
  fullLead: FullLead | null,
  email: { value: string; status: string | null } | null,
  audience: AudienceCard | null,
  offer: OfferCard | null,
  deliveryStatus: FlattenedStatus,
  facts: ResolvedLeadFacts,
  campaigns: LeadCampaignEvidence[] | null,
) {
  return {
    id: row.id,
    leadId: row.leadId,
    namespace: "apollo",
    email: email?.value ?? "",
    apolloPersonId: row.leadApolloPersonId ?? null,
    parentRunId: row.parentRunId,
    runId: row.runId,
    brandIds: row.brandIds,
    campaignId: row.campaignId,
    orgId: row.orgId,
    userId: row.userId ?? null,
    workflowSlug: row.workflowSlug ?? null,
    featureSlug: row.featureSlug ?? null,
    goal: row.goal ?? null,
    activeGoalId: row.activeGoalId ?? null,
    brandProfileId: row.brandProfileId ?? null,
    // The offer this lead belongs to: the offer named by the campaign it was served under, i.e. by
    // the `campaignId` above. null when that campaign names none — or when it could not be asked,
    // which is loud in the logs (see offer-card-client.ts). Never inferred from the brand.
    offer: offer ?? null,
    audienceId: row.audienceId ?? null,
    audience: audience ?? null,
    servedAt: row.servedAt,
    status: row.status as "buffered" | "skipped" | "claimed" | "served",
    emailStatus: email?.status ?? null,
    lead: fullLead,
    statusReason: row.statusReason ?? null,
    statusDetails: row.statusDetails ?? null,
    // Where this person stands on THIS campaign — the served answer, so a consumer renders it
    // rather than deriving one of its own from the raw flags below. See lib/lead-standing.ts.
    standing: facts.standing,
    // THE DEAL, when somebody stated one: what it was worth, what closing it cost the customer,
    // and WHOSE win it was (`causedByOutreach`) — so a table can render a column per lead without
    // a request per lead, and a consumer can hold the deals our outreach caused apart from the
    // ones the brand closed some other way. Null when nobody has stated a sale. See
    // lib/closed-deal.ts.
    closedDeal: facts.closedDeal,
    // The person's campaigns of this brand, each stating what happened IN THAT CAMPAIGN — present
    // only when the caller asked for it with `?include=campaigns`. Every field above stays exactly
    // what it was: the brand-wide roll-up several dashboard surfaces already read.
    ...(campaigns ? { campaigns } : {}),
    ...deliveryStatus,
  };
}

/**
 * Where the caller resumes, or null when this response is the end of the population.
 *
 * A bounded read that came back FULL may have more behind it, so it carries the position of its
 * last row; the caller passes it back as `?cursor=` and continues from strictly after it. A read
 * that came back short (or was never bounded) has reached the end, and says so with null. A walk
 * that lands exactly on the last row gets one more request that returns zero rows and a null
 * cursor — the cost of not counting the whole population on every page.
 */
function nextCursorFor(
  page: LeadListPage,
  rowCount: number,
  last: LeadListCursor | null,
): string | null {
  if (page.limit === null || last === null) return null;
  if (rowCount < page.limit) return null;
  return encodeLeadCursor(last);
}


/**
 * The full-projection walk, as a stream of chunks.
 *
 * Identical to the loop it replaces: keyset over `(created_at, id)`, `offset` positions the first
 * chunk only, never more rows read than the caller's `limit`. It is a generator so that the
 * index-driven read (which chooses its own rows) can feed the SAME emit loop, which is what keeps
 * a searched page and a plain page serialized by one piece of code.
 */
async function* streamFullLeadChunks(
  scope: LeadListScope,
  page: LeadListPage,
  chunkSize: number,
): AsyncGenerator<LeadCampaignRow[]> {
  let cursor: LeadCampaignCursor | null = page.cursor;
  let offset: number | null = page.offset;
  let remaining: number | null = page.limit;
  while (remaining === null || remaining > 0) {
    const take = remaining === null ? chunkSize : Math.min(chunkSize, remaining);
    const rows = await fetchLeadCampaignChunk(scope, cursor, take, offset);
    offset = null;
    if (rows.length === 0) return;
    yield rows;
    if (remaining !== null) remaining -= rows.length;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.cursorCreatedAt, id: last.id };
    if (rows.length < take) return;
  }
}

/** Put hydrated rows back in the order the index chose. A row the hydration lost is skipped, not faked. */
function inIndexOrder<T extends { id: string }>(rows: T[], ids: readonly string[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is T => row !== undefined);
}

/**
 * Hydrate the ids an index-driven page chose, a chunk at a time, in the index's order.
 *
 * The ids are already the winners of the same dedup the list applies, so they are hydrated by id
 * on the OUTER query alone (see `rowIds`) and re-ordered here — the SQL order is the list's, not
 * this read's.
 */
async function* streamChunksByIds<T extends { id: string }>(
  scope: LeadListScope,
  batches: AsyncGenerator<string[]>,
  fetch: (scope: LeadListScope, count: number) => Promise<T[]>,
): AsyncGenerator<T[]> {
  for await (const slice of batches) {
    const rows = await fetch({ ...scope, rowIds: slice }, slice.length);
    const ordered = inIndexOrder(rows, slice);
    if (ordered.length > 0) yield ordered;
  }
}

/**
 * A read this service refuses, stated with the status the caller should see.
 *
 * Thrown from the plan walk, which runs before a byte is written, so the handler's own catch can
 * answer it properly. FAIL LOUD: a filtered read whose filter could not be evaluated must never
 * come back 200 with a differently-filtered list.
 */
class LeadReadRefused extends Error {
  constructor(readonly status: number, readonly payload: string) {
    super(payload);
    this.name = "LeadReadRefused";
  }
}

/** What a caller asks the response to be. Absent means JSON, exactly as today. */
type LeadListFormat = "json" | "csv";

function parseLeadFormat(raw: unknown): LeadListFormat {
  if (raw === undefined) return "json";
  if (typeof raw !== "string") throw new Error("format must be a single format name");
  const trimmed = raw.trim();
  if (trimmed === "json" || trimmed === "csv") return trimmed;
  throw new Error(`Unknown format '${raw}'. Valid: json, csv`);
}

/**
 * The standing of every row in one chunk. A resolver failure is NOT allowed to take the walk down:
 * the standing of a lead whose funnel or statements could not be read is stated as unresolved, and
 * the raw delivery facts beside it are unaffected. Anything else would fail a 57k-row list read
 * over one derived field.
 */
async function resolveStandings(
  resolver: LeadStandingResolver,
  rows: StandingRow[],
): Promise<Map<string, ResolvedLeadFacts>> {
  try {
    return await resolver.resolve(rows);
  } catch (error) {
    console.error(
      "[lead-service] lead standing could not be resolved for this chunk; every row in it reads " +
        `as unresolved rather than as a guess: ${(error as Error).message}`,
    );
    return new Map();
  }
}

/**
 * What a row reads as when its statements could not be read at all. Never a plausible default: the
 * standing says `unresolved` with the reason on the wire, and the closed deal is null beside it —
 * a consumer that reads one reads the other, so an unreadable row is never mistaken for a person
 * who simply has not bought.
 */
function unresolvedFacts(): ResolvedLeadFacts {
  return {
    standing: {
      state: "unresolved",
      signal: "none",
      origin: null,
      reason: "statements_unreadable",
      funnelKey: null,
      entryStep: null,
      entryMeasure: null,
      reachedEntryStep: null,
      deepestStep: null,
      at: null,
    },
    closedDeal: null,
  };
}

/**
 * WHICH rows a read is about, resolved once for the list, the export and the bucket counts.
 *
 * Everything here is scope, and scope is exactly what a count and a list must agree on: an offer
 * resolves to the campaigns selling it, a campaign resolves to its whole IDENTITY, and the delivery
 * answer is flattened to whichever of those the read named. Two implementations of this would be
 * two populations wearing one name — a tab that says 300 and then shows 280.
 */
type LeadScopeResolution =
  | { kind: "error"; status: number; error: string }
  /** An offer no campaign sells yet: a real, empty answer, and never the brand's leads. */
  | { kind: "empty" }
  | {
      kind: "scope";
      scope: LeadListScope;
      statusCampaignIdStr: string | undefined;
      hasScopeForStatus: boolean;
      flatten: (result: StatusResult) => FlattenedStatus;
    };

async function resolveLeadReadScope(
  req: AuthenticatedRequest,
  statuses: readonly string[],
): Promise<LeadScopeResolution> {
  const { brandId, campaignId, offerId, funnelKey, orgId: queryOrgId, userId, workflowSlug } = req.query;
  const brandIdStr = typeof brandId === "string" ? brandId : undefined;
  const campaignIdStr = typeof campaignId === "string" ? campaignId : undefined;
  const offerIdStr = typeof offerId === "string" ? offerId : undefined;
  const queryOrgIdStr = typeof queryOrgId === "string" ? queryOrgId : undefined;
  const userIdStr = typeof userId === "string" ? userId : undefined;
  const workflowSlugStr = typeof workflowSlug === "string" ? workflowSlug : undefined;

    // A campaign sells exactly ONE offer, so naming both an offer and a campaign states two
    // narrowings where one already implies the other — either the campaign is in the offer (the
    // offer adds nothing) or it is not (the pair matches nothing, and whichever the caller meant
    // is unknowable). Refused rather than silently resolved one way.
  // One sales funnel of an offer: the offer's campaigns that STATE that funnel. Either spelling of
  // a key is accepted and read in canonical form. An unknown key, or a funnel named without the
  // offer it narrows, is refused — never silently ignored, which would answer a funnel page with
  // the whole offer's leads under the funnel's name.
  let funnelKeyCanonical: FunnelKey | null = null;
  if (funnelKey !== undefined) {
    funnelKeyCanonical = canonicalizeFunnelKey(funnelKey);
    if (!funnelKeyCanonical) {
      return {
        kind: "error",
        status: 400,
        error: `funnelKey must be one of ${FUNNEL_KEYS.join(", ")} (or a retired spelling of one), got ${JSON.stringify(funnelKey)}`,
      };
    }
    if (!offerIdStr) {
      return {
        kind: "error",
        status: 400,
        error: "funnelKey narrows an offer to one of its sales funnels — name the offerId it narrows",
      };
    }
  }

  if (offerIdStr && campaignIdStr) {
    return {
      kind: "error",
      status: 400,
      error:
        "offerId and campaignId both narrow the read and a campaign already sells exactly one offer — pass one, not both",
    };
  }

    // A lead's offer is the offer named by the campaign it was served under, and `campaign_id` on
    // the membership row is that frozen attribution — so an offer scope resolves to the campaign
    // ids selling it and rides the SAME campaign-id filter a campaign scope uses. FAIL LOUD: with
    // campaign-service unreachable those ids are unknown, and dropping the filter would serve the
    // whole BRAND under one offer's name, which is exactly the bug offer scope fixes.
    let offerCampaignIds: string[] | null = null;
    if (offerIdStr) {
      try {
        offerCampaignIds = await resolveOfferCampaignIds(
          offerIdStr,
          {
            orgId: req.orgId!,
            userId: req.userId ?? null,
            runId: req.runId ?? null,
            brandId: brandIdStr ?? null,
          },
          funnelKeyCanonical,
        );
      } catch (error) {
        console.error(
          `[lead-service] offer scope unresolved for offerId=${offerIdStr} orgId=${req.orgId} — ` +
            `refusing the read rather than widening it to the brand: ${(error as Error).message}`,
        );
        return {
          kind: "error",
          status: 502,
          error:
            error instanceof OfferCampaignsUnavailableError
              ? error.message
              : "campaign-service unavailable",
        };
      }

      // No campaign sells this offer (through this funnel, when one is named) yet, so no lead has
      // been served under it. That is a real, correct answer — and the one place a missing filter
      // would otherwise become the brand.
      if (offerCampaignIds.length === 0) return { kind: "empty" };
    }

    // A campaign as the customer knows it is an IDENTITY (org, brand, sales funnel, acquisition
    // channel), not one stored campaign row: campaign-service used to mint a new row on every
    // workflow switch, so one campaign lives in storage as many. A campaign-scoped read totals the
    // whole identity — the same population features-service already totals for the same scope, so
    // the money and the people on one campaign page describe the same thing. Resolution failing
    // falls back to the single requested row, loudly, never to a partial family or the brand.
    const campaignFamily = campaignIdStr
      ? await resolveCampaignFamily(campaignIdStr, {
          orgId: req.orgId!,
          userId: req.userId ?? null,
          runId: req.runId ?? null,
          brandId: brandIdStr ?? null,
        })
      : null;

    // One shared scope for both the slim (`?view=basic`) and full paths. Brand/org scope — and a
    // campaign identity spanning several rows — collapses to one row per lead_id downstream; a
    // single-row campaign scope stays flat.
    const scope: LeadListScope = {
      orgId: req.orgId!,
      brandId: brandIdStr,
      campaignId: campaignIdStr,
      offerId: offerIdStr,
      funnelKey: funnelKeyCanonical ?? undefined,
      campaignIds: offerCampaignIds ?? campaignFamily ?? undefined,
      queryOrgId: queryOrgIdStr,
      userId: userIdStr,
      workflowSlug: workflowSlugStr,
      statuses,
    };

    const scopeCampaignIds = campaignScopeIds(scope);
    const statusCampaignIdStr = statusCampaignId(scopeCampaignIds);
    const familySet =
      scopeCampaignIds && scopeCampaignIds.length > 1 ? new Set(scopeCampaignIds) : null;

    const hasScopeForStatus = !!(campaignIdStr || brandIdStr || offerIdStr);
    // Keyed on the resolved campaign ids, not on which param named them: a scope carrying ONE
    // campaign row asks email-gateway in campaign mode, several take brand mode and read the
    // per-campaign breakdown back out (aggregateFamilyScope). Identical to the previous
    // `campaignIdStr` test for every campaign-scoped read — that param sets these ids — and it is
    // what gives an offer's several campaigns the same widened engagement a campaign identity gets.
    const flatten = familySet
      ? (result: StatusResult) => flattenFamilyStatus(result, familySet)
      : scopeCampaignIds
        ? flattenCampaignStatus
        : flattenBrandStatus;

  return { kind: "scope", scope, statusCampaignIdStr, hasScopeForStatus, flatten };
}

/**
 * `view=compact` is gzipped when the caller accepts it (Node's `fetch` asks for it and decodes it
 * transparently). Scoped to that view ONLY: every other response of this route keeps its exact
 * encoding, so no existing consumer — including any proxy that copies headers onto a body it has
 * already decoded — sees a byte change. The JSON is highly repetitive (the same keys on every row),
 * so this is the larger half of what makes a whole-brand walk light on the wire.
 */
const compactCompression = compression({ filter: (req) => req.query.view === "compact" });

router.get("/orgs/leads", apiKeyAuth, requireOrgId, compactCompression, async (req: AuthenticatedRequest, res) => {
  let streamingStarted = false;
  // Every byte of a streamed response goes through this: it batches the per-row writes and waits
  // when the socket is full, so what this process holds is one batch rather than the difference
  // between database speed and network speed (see stream-writer.ts).
  const writer = new ResponseWriter(res);
  // Whether anyone is still listening. A whole-population walk holds a database connection for its
  // whole duration, so a caller that gave up at its own HTTP timeout must stop it — see
  // src/lib/client-abort.ts for what that cost when nothing checked.
  const client = watchClient(req, res);
  try {
    if (req.runId) {
      traceEvent(req.runId, { service: "lead-service", event: "leads-query-start", detail: `orgId=${req.orgId}` }, req.headers).catch(() => {});
    }

    // Read here only for what the row-level resolvers need; WHICH rows the read is about is
    // resolved once, for this route and the bucket counts alike, by resolveLeadReadScope.
    const { brandId } = req.query;
    const brandIdStr = typeof brandId === "string" ? brandId : undefined;

    // What the caller wants BESIDE the row. `include=campaigns` nests this person's campaigns of
    // this brand under the row, each card stating what happened in that campaign alone. Absent
    // means today's response, byte for byte; an unknown value is a 400, never ignored — a silently
    // dropped include is a consumer rendering an empty panel with nothing anywhere going red.
    let includeCampaigns = false;
    {
      const include = req.query.include;
      const raw = typeof include === "string" ? include : undefined;
      if (raw !== undefined) {
        const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
        for (const part of parts) {
          if (part !== "campaigns") {
            return res.status(400).json({
              error: `include must be a comma-separated list of: campaigns (got '${part}')`,
            });
          }
        }
        includeCampaigns = parts.includes("campaigns");
      }
    }

    // `?view=compact` — the per-lead delivery evidence plus the identity a figure row renders, and
    // nothing else (see toCompactLead). It skips the audience, offer and standing resolution the
    // other views pay per chunk, so it cannot also carry a nested campaign breakdown: asking for
    // both is a 400, never a silently dropped include. An export (`format=csv`) keeps its own shape.
    const compact = req.query.view === "compact" && req.query.format !== "csv";
    if (compact && includeCampaigns) {
      return res.status(400).json({ error: "include=campaigns is not available on view=compact" });
    }

    // Which lifecycle statuses this read answers for. Absent means the actionable population
    // (DEFAULT_LEAD_LIST_STATUSES — everything but `skipped`); `?status=all` or an explicit list
    // asks for more. A bad value is a 400 before any work starts, never a silent fallback.
    let statuses: readonly string[];
    let page: LeadListPage;
    // What the caller wants of the POPULATION rather than of each row: a free-text search over the
    // whole matching set, one engagement bucket of it, a different order, or the whole thing as a
    // file. Each is absent by default and each is a 400 when it is not understood — a silently
    // dropped filter is a consumer rendering a filtered-looking list that was never filtered.
    let searchTokens: string[] | null;
    let bucket: LeadBucket | null;
    let standings: readonly LeadStandingState[] | null;
    let stages: readonly SalesInterestStage[] | null;
    let sort: LeadSortOrder;
    let format: LeadListFormat;
    try {
      statuses = parseLeadStatusFilter(req.query.status);
      searchTokens = parseLeadSearch(req.query.q);
      bucket = parseLeadBucket(req.query.bucket);
      standings = parseLeadStandingFilter(req.query.standing);
      // Where on the funnel a `sales_interest` lead stands — a partition of that one standing, so
      // a board can draw a column per funnel step. Only `sales_interest` rows carry a stage, so
      // naming one narrows to them. Absent = no stage filter, byte-identical to before.
      stages = parseSalesInterestStageFilter(req.query.stage);
      sort = parseLeadSort(req.query.sort);
      format = parseLeadFormat(req.query.format);
      // How much of that population to return, and where to start. Absent `limit` means the whole
      // thing — the read every caller got before bounds existed, and what the staff console still
      // asks for. Anything unreadable is a 400 before any work starts: a bound that is accepted
      // and dropped is the bug being fixed here, so nothing about paging fails quietly.
      page = parseLeadListPage(req.query);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }

    // WHICH population this read is about — the offer/campaign-identity resolution, the delivery
    // scope and the flatten that goes with it. Shared with the bucket-count read so a tab's count
    // and the rows that tab returns are, by construction, the same population.
    const resolved = await resolveLeadReadScope(req, statuses);
    if (resolved.kind === "error") {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    if (resolved.kind === "empty") {
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        return res.send(leadExportHeader());
      }
      // Same rule as every other read: a caller that named a bound or a filter is told how many
      // rows it is paging through, and here that is honestly zero.
      const bounded =
        searchTokens !== null ||
        bucket !== null ||
        standings !== null ||
        stages !== null ||
        sort !== "created" ||
        page.limit !== null ||
        page.offset !== null ||
        page.cursor !== null;
      return res.json({ leads: [], nextCursor: null, ...(bounded ? { total: 0 } : {}) });
    }
    const { scope, statusCampaignIdStr, hasScopeForStatus, flatten } = resolved;

    const context = getServiceContext(req);
    const audienceCtx: AudienceResolveContext = {
      orgId: req.orgId!,
      userId: req.userId ?? null,
      runId: req.runId ?? null,
    };
    // ONE resolver for the whole response, built before the walk: the campaign -> offer read is
    // org-wide and each brand's offer catalogue is read once, so naming the offer on fifty thousand
    // rows costs the same two calls as naming it on one. Never constructed inside the chunk loop.
    const offerResolver = createOfferCardResolver({
      orgId: req.orgId!,
      userId: req.userId ?? null,
      runId: req.runId ?? null,
      brandId: brandIdStr ?? null,
    });
    // Likewise ONE standing resolver for the whole response: the org's campaign -> funnel map is
    // read once and reused by every chunk, so naming the standing on fifty thousand rows costs the
    // same single campaign-service call as naming it on one.
    const standingResolver = createLeadStandingResolver({
      orgId: req.orgId!,
      userId: req.userId ?? null,
      runId: req.runId ?? null,
      brandId: brandIdStr ?? null,
      deliveryQueried: hasScopeForStatus,
    });
    // The nested campaign cards, when asked for. ONE resolver for the whole response: the org's
    // campaign identities and its campaign -> offer map are read once and reused by every chunk.
    const breakdownResolver: CampaignBreakdownResolver | null = includeCampaigns
      ? createCampaignBreakdownResolver({
          scope,
          orgId: req.orgId!,
          userId: req.userId ?? null,
          runId: req.runId ?? null,
          brandId: brandIdStr ?? null,
          deliveryQueried: hasScopeForStatus,
          offerResolver,
          singleCampaignScopeId: statusCampaignIdStr ?? null,
        })
      : null;

    // A read that SEARCHES, buckets or re-orders cannot express its page as a keyset over
    // leads_campaigns alone: the order and the filter depend on evidence held per person (a reply
    // that dates a lead, a click that puts them in a bucket). So the page is chosen from the scope's
    // READ MODEL — one narrow row per person, kept between requests and kept fresh (see
    // lead-read-model.ts) — and only the page's own ids are hydrated. A read naming none of the
    // three never touches a model and is byte-identical to what it has always been.
    const indexed =
      searchTokens !== null ||
      bucket !== null ||
      standings !== null ||
      stages !== null ||
      sort !== "created";
    let plan: LeadPlanPage | null = null;
    // The scope's read model, when this read is answered from one: its count, its order and its
    // filter are all read off the model's rows (see lead-read-model.ts), and the page it picks is
    // then overlaid from the SAME delivery evidence the model was built from — so the row a tab
    // shows and the count that labels the tab come from one answer.
    let model: ReadModel | null = null;
    if (indexed) {
      try {
        model = await ensureReadModel(readModelScopeFor(scope, brandIdStr, hasScopeForStatus));
      } catch (error) {
        if (error instanceof ReadModelUnavailableError) {
          console.error(
            "[lead-service] a filtered/ordered read is refused: its read model could not be built " +
              `or brought up to date, and a wrongly-filtered list is worse than none: ${error.message}`,
          );
          throw new LeadReadRefused(
            502,
            error.source === "standing" ? "lead standing unavailable" : "email-gateway unavailable",
          );
        }
        throw error;
      }
      plan = await readModelPage(model, {
        tokens: searchTokens,
        bucket,
        standings,
        stages,
        sort,
        page,
      });
    }

    // How many rows match what the caller asked for — the number that labels the page, not the
    // size of the brand. An index-driven read already counted them; a plain bounded read counts
    // them with one aggregate over the same relation, so the two can never describe different
    // populations. An UNBOUNDED, unfiltered read does not compute it at all and its response is
    // unchanged, byte for byte.
    const wantsTotal =
      format === "json" &&
      (indexed ||
        page.limit !== null ||
        page.offset !== null ||
        page.cursor !== null);
    const total = wantsTotal ? (plan ? plan.total : await countLeadListRows(scope)) : null;

    // `?view=basic` => slim per-lead payload. Anything else (incl. absent) => full
    // FullLead, the existing default. No Zod default: a missing param is full.
    // An export is always taken from the slim projection: a CSV cell cannot hold an employment
    // history, and an export that reads the full graph for a whole brand is the read being fixed.
    const slim = req.query.view === "basic" || compact || format === "csv";

    // Basic view: ONE flat query (current-employer org + primary email via LATERAL),
    // streamed in cursor chunks. This keeps the list shape compatible with api-service
    // while avoiding the "load a whole large brand before first byte" failure mode.
    if (slim) {
      if (format === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="leads-${brandIdStr ?? req.orgId}-${new Date().toISOString().slice(0, 10)}.csv"`,
        );
        await writer.write(leadExportHeader());
      } else {
        res.setHeader("Content-Type", "application/json");
        await writer.write('{"leads":[');
      }
      streamingStarted = true;

      let wroteFirstBasic = false;
      let rowCount = 0;
      let lastPosition: LeadListCursor | null = null;
      // An index-driven read hydrates the ids it already chose, in that order; every other read
      // walks the relation exactly as before.
      const basicSource = plan
        ? streamChunksByIds(scope, plan.ids(LEADS_STREAM_CHUNK_SIZE), (s, count) =>
            fetchBasicLeadChunk(s, null, count),
          )
        : streamBasicLeadChunks(scope, LEADS_STREAM_CHUNK_SIZE, page);
      // A compact walk does two independent waits per chunk — the next rows from the database and
      // this chunk's delivery evidence from email-gateway — so it reads one chunk ahead and the two
      // overlap. The other views keep their exact sequencing.
      for await (const basicRows of compact ? prefetchOne(basicSource) : basicSource) {
        // Between chunks, before this chunk's gateway/audience/standing fan-out: throwing here
        // leaves the generator, which closes the cursor and hands the connection back.
        client.stopIfGone(rowCount);
        rowCount += basicRows.length;
        const lastBasic = basicRows[basicRows.length - 1];
        if (lastBasic) lastPosition = { createdAt: lastBasic.cursorCreatedAt, id: lastBasic.id };

        const statusMap = !hasScopeForStatus
          ? new Map<string, StatusResult>()
          : model
            ? await readModelDelivery(
                model.scope,
                basicRows
                  .filter((r) => r.status === "served" && r.email?.value)
                  .map((r) => ({ brandId: r.brandIds[0] ?? "unknown", email: r.email!.value })),
                model.evidenceAt,
              )
            : await buildStatusMapForBasicRows(basicRows, statusCampaignIdStr, context);

        if (compact) {
          const crmReplies = await fetchCrmPositiveReplyDates(basicRows);
          for (const r of basicRows) {
            const statusResult = statusMap.get(r.email?.value ?? "");
            const delivery =
              hasScopeForStatus && r.status === "served"
                ? (statusResult ? flatten(statusResult) : DEFAULT_STATUS)
                : DEFAULT_STATUS;
            await writer.write((wroteFirstBasic ? "," : "") + JSON.stringify(toCompactLead(r, delivery, crmPositiveReplyAtFor(crmReplies, r))));
            wroteFirstBasic = true;
          }
          continue;
        }

        const audienceMap = await buildAudienceMapForRows(
          basicRows.map((r) => ({
            leadId: r.leadId,
            email: r.email?.value ?? null,
            audienceId: r.audienceId,
            brandIds: r.brandIds,
          })),
          brandIdStr,
          audienceCtx,
        );

        const offerMap = await offerResolver.resolve(basicRows.map((r) => r.campaignId));

        // The overlay is resolved for the whole chunk BEFORE the standing, because the standing
        // reads it: the click that means "reached the step this campaign sells" is the same click
        // the row already carries, never a second lookup.
        const deliveryByRow = new Map<string, FlattenedStatus>();
        for (const r of basicRows) {
          const statusResult = statusMap.get(r.email?.value ?? "");
          deliveryByRow.set(
            r.id,
            hasScopeForStatus && r.status === "served"
              ? (statusResult ? flatten(statusResult) : DEFAULT_STATUS)
              : DEFAULT_STATUS,
          );
        }
        const standingMap = await resolveStandings(
          standingResolver,
          basicRows.map((r) => ({
            id: r.id,
            leadId: r.leadId,
            campaignId: r.campaignId,
            brandIds: r.brandIds,
            status: r.status,
            delivery: standingDelivery(deliveryByRow.get(r.id)!),
          })),
        );

        const breakdownMap = breakdownResolver
          ? await breakdownResolver.resolve(
              basicRows.map((r) => ({
                id: r.id,
                leadId: r.leadId,
                email: r.email?.value ?? null,
                delivery: deliveryByRow.get(r.id) ?? null,
              })),
              statusMap,
            )
          : null;

        for (const r of basicRows) {
          const emailValue = r.email?.value ?? "";
          const emailStatus = r.email?.status ?? null;
          const deliveryStatus = deliveryByRow.get(r.id)!;
          const facts = standingMap.get(r.id) ?? unresolvedFacts();

          // The slim path's `lead` is the basic projection, not a FullLead — that is the whole
          // point of `?view=basic`, so it is passed through as-is rather than through the shared
          // FullLead-typed serializer.
          const leadOut = {
            id: r.id,
            leadId: r.leadId,
            namespace: "apollo",
            email: emailValue,
            apolloPersonId: r.leadApolloPersonId ?? null,
            parentRunId: r.parentRunId,
            runId: r.runId,
            brandIds: r.brandIds,
            campaignId: r.campaignId,
            orgId: r.orgId,
            userId: r.userId ?? null,
            workflowSlug: r.workflowSlug ?? null,
            featureSlug: r.featureSlug ?? null,
            goal: r.goal ?? null,
            activeGoalId: r.activeGoalId ?? null,
            brandProfileId: r.brandProfileId ?? null,
            // Same field, same meaning, same resolver as the full path — a panel rendered from a
            // slim row must not be missing the offer the full row names.
            offer: offerMap.get(r.campaignId) ?? null,
            audienceId: r.audienceId ?? null,
            audience: audienceMap.get(r.leadId) ?? null,
            servedAt: r.servedAt,
            status: r.status as "buffered" | "skipped" | "claimed" | "served",
            emailStatus,
            lead: r.lead,
            statusReason: r.statusReason ?? null,
            statusDetails: r.statusDetails ?? null,
            // Same field, same policy, same resolver as the full path — a slim row and a full row
            // for the same lead must not disagree about where that person stands, or about
            // whether that person bought and whose win it was.
            standing: facts.standing,
            closedDeal: facts.closedDeal,
            // Same field, same resolver as the full path — see serializeLeadItem.
            ...(breakdownMap ? { campaigns: breakdownMap.get(r.id) ?? [] } : {}),
            ...deliveryStatus,
          };

          if (format === "csv") {
            await writer.write(leadExportLine(leadOut as unknown as Record<string, unknown>));
          } else {
            await writer.write((wroteFirstBasic ? "," : "") + JSON.stringify(leadOut));
          }
          wroteFirstBasic = true;
        }
      }

      if (format === "csv") {
        await writer.end();
      } else {
        const nextCursor = plan ? plan.nextCursor : nextCursorFor(page, rowCount, lastPosition);
        await writer.write(
          `],"nextCursor":${JSON.stringify(nextCursor)}` +
            (total === null ? "" : `,"total":${total}`) +
            "}",
        );
        await writer.end();
      }

      if (req.runId) {
        traceEvent(req.runId, { service: "lead-service", event: "leads-query-done", detail: `count=${rowCount}`, data: { count: rowCount } }, req.headers).catch(() => {});
      }
      return;
    }

    const primaryEmail = (lead: FullLead | undefined): { value: string; status: string | null } | null => {
      if (!lead) return null;
      const email = lead.contacts.find((c) => c.channel === "email");
      return email ? { value: email.value, status: email.status } : null;
    };

    // The DB query above is the last point a clean 500 can be sent. Everything below
    // writes to the socket; from here on, failures destroy the stream (headers are sent).
    res.setHeader("Content-Type", "application/json");
    await writer.write('{"leads":[');
    streamingStarted = true;

    let wroteFirst = false;
    let cursor: LeadCampaignCursor | null = null;
    let rowCount = 0;
    // Same two sources as the slim path: the ids an index-driven read chose, or the keyset walk.
    const fullSource = plan
      ? streamChunksByIds(scope, plan.ids(LEADS_STREAM_CHUNK_SIZE), (s, count) =>
          fetchLeadCampaignChunk(s, null, count),
        )
      : streamFullLeadChunks(scope, page, LEADS_STREAM_CHUNK_SIZE);
    for await (const chunkRows of fullSource) {
      client.stopIfGone(rowCount);
      rowCount += chunkRows.length;
      const chunkLeadIds = Array.from(new Set(chunkRows.map((r) => r.leadId)));
      const fullLeadByLeadId = await buildFullLeadsBatch(chunkLeadIds);

      const audienceMap = await buildAudienceMapForRows(
        chunkRows.map((row) => ({
          leadId: row.leadId,
          email: primaryEmail(fullLeadByLeadId.get(row.leadId))?.value ?? null,
          audienceId: row.audienceId,
          brandIds: row.brandIds,
        })),
        brandIdStr,
        audienceCtx,
      );

      const offerMap = await offerResolver.resolve(chunkRows.map((row) => row.campaignId));

      // Delivery-status overlay, scoped to this chunk's served rows only.
      const statusMap = new Map<string, StatusResult>();
      if (hasScopeForStatus && model) {
        const fromModel = await readModelDelivery(
          model.scope,
          chunkRows.flatMap((row) => {
            const email = primaryEmail(fullLeadByLeadId.get(row.leadId))?.value;
            return row.status === "served" && email
              ? [{ brandId: row.brandIds[0] ?? "unknown", email }]
              : [];
          }),
          model.evidenceAt,
        );
        for (const [email, result] of fromModel) statusMap.set(email, result);
      } else if (hasScopeForStatus) {
        const groups = new Map<string, { brandId: string; items: DeliveryStatusItem[] }>();
        for (const row of chunkRows) {
          if (row.status !== "served") continue;
          const email = primaryEmail(fullLeadByLeadId.get(row.leadId))?.value;
          if (!email) continue;
          const primaryBrandId = row.brandIds[0] ?? "unknown";
          if (!groups.has(primaryBrandId)) {
            groups.set(primaryBrandId, { brandId: primaryBrandId, items: [] });
          }
          groups.get(primaryBrandId)!.items.push({ email });
        }
        await Promise.all(
          Array.from(groups.values()).map(async (group) => {
            const response = await checkDeliveryStatus(group.brandId, statusCampaignIdStr, group.items, context);
            for (const result of response.results) statusMap.set(result.email, result);
          }),
        );
      }

      // Resolved for the whole chunk before anything is written, because the standing reads the
      // overlay: the click that means "reached the step this campaign sells" is the same click the
      // row already carries.
      const deliveryByRow = new Map<string, FlattenedStatus>();
      for (const row of chunkRows) {
        const statusResult = statusMap.get(primaryEmail(fullLeadByLeadId.get(row.leadId))?.value ?? "");
        deliveryByRow.set(
          row.id,
          hasScopeForStatus && row.status === "served"
            ? (statusResult ? flatten(statusResult) : DEFAULT_STATUS)
            : DEFAULT_STATUS,
        );
      }
      const standingMap = await resolveStandings(
        standingResolver,
        chunkRows.map((row) => ({
          id: row.id,
          leadId: row.leadId,
          campaignId: row.campaignId,
          brandIds: row.brandIds,
          status: row.status,
          delivery: standingDelivery(deliveryByRow.get(row.id)!),
        })),
      );

      const breakdownMap = breakdownResolver
        ? await breakdownResolver.resolve(
            chunkRows.map((row) => ({
              id: row.id,
              leadId: row.leadId,
              email: primaryEmail(fullLeadByLeadId.get(row.leadId))?.value ?? null,
              delivery: deliveryByRow.get(row.id) ?? null,
            })),
            statusMap,
          )
        : null;

      for (const row of chunkRows) {
        const fullLead = fullLeadByLeadId.get(row.leadId) ?? null;
        const email = primaryEmail(fullLead ?? undefined);
        const deliveryStatus = deliveryByRow.get(row.id)!;

        const leadOut = serializeLeadItem(
          row,
          fullLead,
          email,
          audienceMap.get(row.leadId) ?? null,
          offerMap.get(row.campaignId) ?? null,
          deliveryStatus,
          standingMap.get(row.id) ?? unresolvedFacts(),
          breakdownMap ? (breakdownMap.get(row.id) ?? []) : null,
        );

        await writer.write((wroteFirst ? "," : "") + JSON.stringify(leadOut));
        wroteFirst = true;
      }

      const lastRow = chunkRows[chunkRows.length - 1];
      cursor = { createdAt: lastRow.cursorCreatedAt, id: lastRow.id };
    }

    const nextCursor = plan ? plan.nextCursor : nextCursorFor(page, rowCount, cursor);
    await writer.write(
      `],"nextCursor":${JSON.stringify(nextCursor)}` +
        (total === null ? "" : `,"total":${total}`) +
        "}",
    );
    await writer.end();

    if (req.runId) {
      traceEvent(req.runId, { service: "lead-service", event: "leads-query-done", detail: `count=${rowCount}`, data: { count: rowCount } }, req.headers).catch(() => {});
    }
  } catch (error) {
    if (isClientGone(error)) {
      // Not a failure of ours: the caller stopped reading and the walk was released rather than
      // held. Said out loud (a truncated stream is never a complete one), and not as an error.
      console.warn(`[lead-service] leads read abandoned by the caller: ${error.message}`);
      res.destroy();
    } else if (error instanceof LeadReadRefused && !streamingStarted && !res.headersSent) {
      res.status(error.status).json({ error: error.payload });
    } else {
      console.error("[lead-service] Leads error:", error);
      if (streamingStarted || res.headersSent) {
        // Stream already open — can't send a 500 body. Destroy the socket so the caller
        // sees a truncated/aborted response and treats it as a failure (fail loud).
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      } else {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  } finally {
    client.dispose();
  }
});

/**
 * GET /orgs/leads/bucket-counts — how many people are in each engagement bucket, and no rows.
 *
 * The customer's Leads page labels a tab per bucket and states the page's population. It used to
 * get those numbers by taking every lead and counting them in the browser: 44 MB and about 6.6s
 * for one production brand, on a tab that re-reads every 15 seconds, and too big for the browser
 * to cache at all — so the page cold-loaded from scratch on every visit. That is the whole reason
 * this exists: a count is a number, and a number should not cost a population.
 *
 * Same scope vocabulary as the list, meaning exactly the same thing: `brandId` / `campaignId`
 * (resolved to the campaign IDENTITY) / `offerId` / `status` / `q`. So a tab's count and what the
 * tab shows are the same set — both are `fetchLeadIndex` over `resolveLeadReadScope`, and the
 * counts fall out of the same evidence the list overlays onto each row.
 *
 * Every bucket key is always present; a bucket nobody is in is 0, never absent. A consumer shows
 * whichever of them its brand's funnel actually prices — this read does not decide that, because
 * a brand can run several funnels at once and the honest answer is all of them.
 *
 * `total` is the whole scoped population, buckets and all, including the people who carry no
 * evidence at all and can therefore be in no bucket (about 5,000 of one brand's 12,945). Bucket
 * membership is NOT exclusive and the counts do not sum to it: somebody who bought was also
 * contacted, and is in both.
 *
 * FAIL LOUD: email-gateway unreachable is a 502, never a count of zero — a wrong number here is
 * one nothing anywhere would go red about.
 */
router.get("/orgs/leads/bucket-counts", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  try {
    let statuses: readonly string[];
    let searchTokens: string[] | null;
    try {
      statuses = parseLeadStatusFilter(req.query.status);
      searchTokens = parseLeadSearch(req.query.q);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }

    const resolved = await resolveLeadReadScope(req, statuses);
    if (resolved.kind === "error") {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    // An offer no campaign sells: a real, empty population, stated as such rather than widened.
    if (resolved.kind === "empty") {
      return res.json({ total: 0, counts: zeroBucketCounts() });
    }

    const brandId = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
    // Counted off the scope's read model — the same rows `GET /orgs/leads?bucket=` pages through
    // (see lead-read-model.ts). A count is a number and no longer costs the population it counts.
    let model: ReadModel;
    try {
      model = await ensureReadModel(
        readModelScopeFor(resolved.scope, brandId, resolved.hasScopeForStatus),
      );
    } catch (error) {
      if (error instanceof ReadModelUnavailableError) {
        console.error(
          "[lead-service] bucket counts refused: the read model they are counted from could not " +
            `be built or brought up to date: ${error.message}`,
        );
        return res.status(502).json({
          error: error.source === "standing" ? "lead standing unavailable" : "email-gateway unavailable",
        });
      }
      throw error;
    }

    return res.json(await readModelBucketCounts(model, searchTokens));
  } catch (error) {
    console.error("[lead-service] Bucket counts error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * `breakdown` on GET /orgs/leads/standing-counts: absent -> false (the response is exactly what it
 * always was); `stage` -> true (adds `salesInterestStages`). Anything else is a 400.
 */
function parseStandingBreakdown(raw: unknown): boolean {
  if (raw === undefined) return false;
  if (raw === "stage") return true;
  throw new Error("breakdown must be `stage`");
}

/**
 * The `sales_interest` partition by funnel stage, ordered: the named funnel's stages first, in
 * funnel order and always present, then any other stage observed (a scope spanning several funnels),
 * in the canonical stage order. Sums to `counts.sales_interest` by construction.
 */
function stageBreakdown(
  funnelStages: readonly SalesInterestStage[],
  observed: ReadonlyMap<string, number>,
): Array<{ stage: string; count: number }> {
  const order: string[] = [...funnelStages];
  for (const stage of SALES_INTEREST_STAGES) if (observed.has(stage) && !order.includes(stage)) order.push(stage);
  for (const stage of observed.keys()) if (!order.includes(stage)) order.push(stage);
  return order.map((stage) => ({ stage, count: observed.get(stage) ?? 0 }));
}

/**
 * GET /orgs/leads/standing-counts — how many leads stand in each state, and no rows.
 *
 * A triage board draws one column per STANDING (still in play, sales interest, disqualified,
 * opted out, and the unresolved case) and states each column's size. Doing that by fetching a
 * bounded page of leads and sorting the cards in the browser makes every number on the screen
 * about a different population: one production campaign has 2,052 leads in scope, 200 of them
 * fetched, so the page reads "200 leads" and "19 sales interests" directly beneath its own heading,
 * which correctly reads "2,052 leads". Every number is real and none of them agree.
 *
 * So this answers the whole scope, and returns no lead rows. It takes the SAME scope vocabulary as
 * GET /orgs/leads — `brandId`, `campaignId` (resolved to the whole campaign identity), `offerId`,
 * `status`, `q` — through the SAME resolution (resolveLeadReadScope), over the SAME index, with
 * the SAME delivery overlay and the SAME standing resolver the list uses. A column's stated size
 * and what `GET /orgs/leads?standing=<state>` then shows are the same set by construction.
 *
 * Standing IS a partition, unlike the engagement buckets: a lead has exactly one, so these counts
 * SUM to `total`. `unresolved` is one of them and is counted like any other — a board that dropped
 * the leads nobody could resolve would not add up to the population it says it is showing.
 *
 * FAIL LOUD: email-gateway unreachable is a 502 and so is a standing that cannot be resolved at
 * all — never a count of zero, which is a wrong number nothing anywhere would go red about.
 */
router.get("/orgs/leads/standing-counts", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  try {
    let statuses: readonly string[];
    let searchTokens: string[] | null;
    let withStages: boolean;
    try {
      statuses = parseLeadStatusFilter(req.query.status);
      searchTokens = parseLeadSearch(req.query.q);
      withStages = parseStandingBreakdown(req.query.breakdown);
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
    // The stages a named funnel's sales_interest leads can stand at, in funnel order — each is
    // always present (0 when nobody stands there) so a board draws every column of that funnel.
    const funnelKeyForStages = canonicalizeFunnelKey(req.query.funnelKey);
    const funnelStages: readonly SalesInterestStage[] = funnelKeyForStages
      ? salesInterestStagesOf(FUNNEL_ENTRY[funnelKeyForStages], FUNNEL_STEPS[funnelKeyForStages])
      : [];

    const resolved = await resolveLeadReadScope(req, statuses);
    if (resolved.kind === "error") {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    // An offer no campaign sells: a real, empty population, stated as such rather than widened.
    if (resolved.kind === "empty") {
      return res.json({
        total: 0,
        counts: zeroStandingCounts(),
        ...(withStages ? { salesInterestStages: stageBreakdown(funnelStages, new Map()) } : {}),
      });
    }

    const brandId = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
    // Counted off the scope's read model — the same rows `GET /orgs/leads?standing=` pages
    // through, each carrying the one standing the list's own resolver gave it.
    let model: ReadModel;
    try {
      model = await ensureReadModel(
        readModelScopeFor(resolved.scope, brandId, resolved.hasScopeForStatus),
      );
    } catch (error) {
      if (error instanceof ReadModelUnavailableError) {
        console.error(
          "[lead-service] standing counts refused: the read model they are counted from could " +
            `not be built or brought up to date: ${error.message}`,
        );
        return res.status(502).json({
          error: error.source === "standing" ? "lead standing unavailable" : "email-gateway unavailable",
        });
      }
      throw error;
    }

    if (!withStages) return res.json(await readModelStandingCounts(model, searchTokens));
    const { total, counts, stages } = await readModelStandingAndStageCounts(model, searchTokens);
    return res.json({ total, counts, salesInterestStages: stageBreakdown(funnelStages, stages) });
  } catch (error) {
    console.error("[lead-service] Standing counts error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Query parameters `GET /orgs/leads/changes` refuses: each one shapes a PAGE of the list, and a
 * change feed is the whole scope or nothing. Naming one is a 400, never silently dropped — a caller
 * that believes it filtered a copy it did not filter would compute on the wrong population.
 */
const CHANGE_FEED_REFUSED_PARAMS = [
  "q", "bucket", "standing", "stage", "sort", "format", "include", "limit", "offset", "cursor",
] as const;

/**
 * GET /orgs/leads/changes — what changed in a scope's compact lead rows since a position the caller
 * holds, so a consumer keeping a copy of a brand's population stops re-reading all of it.
 *
 * Same scope vocabulary as the list (`brandId`, `campaignId` resolved to the whole identity,
 * `offerId` + `funnelKey`, `status`, `orgId`, `userId`, `workflowSlug`) and the same row: every
 * element of `leads` is exactly what `?view=compact` emits for that row. Without `since` the answer
 * is the whole scope (`full: true`); with it, every row that changed after it (`leads`) and every
 * row that left the scope (`removed`, ids). Either way `cursor` is the position to hand back next
 * time. A `since` that no longer names this scope's feed is answered with the whole scope again,
 * `full: true` and a `reason` — the consumer replaces its copy. See lead-change-feed.ts.
 */
router.get("/orgs/leads/changes", apiKeyAuth, requireOrgId, compression(), async (req: AuthenticatedRequest, res) => {
  let streamingStarted = false;
  const writer = new ResponseWriter(res);
  const client = watchClient(req, res);
  try {
    for (const name of CHANGE_FEED_REFUSED_PARAMS) {
      if (req.query[name] !== undefined) {
        return res.status(400).json({
          error: `${name} is not available on /orgs/leads/changes — the feed is always the whole scope`,
        });
      }
    }
    if (req.query.view !== undefined && req.query.view !== "compact") {
      return res.status(400).json({ error: "/orgs/leads/changes serves the compact row only (view=compact)" });
    }
    let since: FeedPosition | null = null;
    let statuses: readonly string[];
    try {
      statuses = parseLeadStatusFilter(req.query.status);
      const raw = req.query.since;
      if (raw !== undefined) {
        if (typeof raw !== "string" || raw.trim() === "") {
          throw new FeedPositionError("since must be the cursor a previous /orgs/leads/changes answer returned");
        }
        since = decodeFeedPosition(raw.trim());
      }
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }

    const resolved = await resolveLeadReadScope(req, statuses);
    if (resolved.kind === "error") {
      return res.status(resolved.status).json({ error: resolved.error });
    }
    // An offer no campaign sells: nobody is in it, and there is no feed to hold a position in.
    if (resolved.kind === "empty") {
      return res.json({ full: true, reason: "empty_scope", cursor: null, leads: [], removed: [] });
    }

    const brandIdStr = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
    const feedScope = readModelScopeFor(resolved.scope, brandIdStr, resolved.hasScopeForStatus);
    let feed: ChangeFeed;
    try {
      feed = await openChangeFeed(feedScope);
    } catch (error) {
      if (error instanceof ReadModelUnavailableError) {
        console.error(
          `[lead-service] lead changes refused: the feed could not be brought up to date: ${error.message}`,
        );
        return res.status(502).json({ error: "email-gateway unavailable" });
      }
      throw error;
    }

    // Whether the caller's position is one this scope's feed can continue from.
    let reason: "no_cursor" | "feed_replaced" | null = since ? null : "no_cursor";
    if (since && since.feedId !== feed.id) {
      if (await feedById(since.feedId)) {
        return res.status(400).json({ error: "since belongs to a different scope than this read names" });
      }
      reason = "feed_replaced";
      since = null;
    }

    let read;
    try {
      read = await readChangeFeed(feed, since ? since.version : null);
    } catch (error) {
      if (error instanceof FeedPositionError) return res.status(400).json({ error: error.message });
      throw error;
    }

    res.setHeader("Content-Type", "application/json");
    streamingStarted = true;
    await writer.write(
      `{"full":${since === null},"reason":${JSON.stringify(reason)},"cursor":${JSON.stringify(read.position)},"leads":[`,
    );
    const removed: string[] = [];
    let wrote = 0;
    for await (const chunk of read.chunks) {
      client.stopIfGone(wrote);
      for (const payload of chunk.put) {
        await writer.write((wrote === 0 ? "" : ",") + payload);
        wrote += 1;
      }
      removed.push(...chunk.removed);
    }
    await writer.write(`],"removed":${JSON.stringify(removed)}}`);
    await writer.end();
  } catch (error) {
    if (isClientGone(error)) {
      console.warn(`[lead-service] lead changes: caller left mid-stream (${error.message})`);
      res.destroy();
      return;
    }
    console.error("[lead-service] lead changes error:", error);
    if (!streamingStarted) return res.status(500).json({ error: "Internal server error" });
    res.destroy(error as Error);
  }
});

/**
 * POST /orgs/leads/evidence-changed — these addresses' delivery evidence just changed.
 *
 * The Leads page's counts and filtered pages read a model that keeps each address's delivery
 * evidence for at most five minutes (lead-read-model.ts). That bound is fine for an open the
 * provider observed; it is not fine for something a PERSON just did in the product — classifying a
 * reply, recording an opt-out — which they expect to see on the next read. So the service that
 * holds that evidence says so here, and the next read of any scope holding one of these addresses
 * asks the delivery layer again before it answers. Cheap on purpose: it records and returns.
 */
router.post("/orgs/leads/evidence-changed", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  const parsed = LeadEvidenceChangedRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
  }
  try {
    const accepted = await noteEvidenceChanged(req.orgId!, parsed.data.emails);
    return res.status(202).json({ accepted });
  } catch (error) {
    console.error("[lead-service] evidence-changed could not be recorded:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/** `leads_campaigns.id` is a uuid column, so anything else can only be a caller error, not a miss. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /orgs/leads/:id — the full record of ONE lead, on its own.
 *
 * A surface that shows a table plus a detail panel for the row somebody clicked has, until now,
 * had to read the FULL projection for the whole brand to make the panel work: ~57k rows and well
 * over 100 MB on one production brand, in a browser tab that polls it. This is the read that lets
 * such a caller take the slim list for the table and then ask for depth one row at a time.
 *
 * `:id` is the `id` of a list row — the `leads_campaigns` membership row — so the caller needs
 * nothing it did not already receive. The response is `{ leadDetail: … }`, one object, byte-equal
 * to the element the full list emits for the same row (both go through serializeLeadItem), so a
 * panel renders from it alone.
 *
 * `brandId` / `campaignId` are the SAME optional scoping the list takes, and they mean the same
 * thing here: which scope the delivery overlay answers for. A caller passes back whatever it
 * listed with and the engagement numbers in the panel match the row in the table. Neither one is
 * an entitlement check — `org_id` is, and it is in the lookup predicate.
 *
 * Deliberately NOT a filter on the list route: a consumer asking for one record should not be
 * constructing a list query, and `{ leadDetail }` says what it is where a one-element `{ leads: [] }`
 * would not.
 */
router.get("/orgs/leads/:id", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  try {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      return res.status(400).json({ error: "id must be the `id` of a lead row, a uuid" });
    }

    const row = await fetchLeadCampaignRowById(req.orgId!, id);
    if (!row) return res.status(404).json({ error: "Lead not found" });

    const { brandId, campaignId } = req.query;
    const brandIdStr = typeof brandId === "string" ? brandId : undefined;
    const campaignIdStr = typeof campaignId === "string" ? campaignId : undefined;

    // Same `include` the list takes, meaning the same thing: nest this person's campaigns of this
    // brand under the record, each card stating what happened in that campaign alone. A panel
    // rendered from the detail read and one rendered from a list row must not differ.
    let includeCampaigns = false;
    {
      const include = req.query.include;
      const raw = typeof include === "string" ? include : undefined;
      if (raw !== undefined) {
        const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
        for (const part of parts) {
          if (part !== "campaigns") {
            return res.status(400).json({
              error: `include must be a comma-separated list of: campaigns (got '${part}')`,
            });
          }
        }
        includeCampaigns = parts.includes("campaigns");
      }
    }

    // A brand scope the row is not part of names a lead this caller is not reading in that scope;
    // answer exactly as if it did not exist rather than leaking its existence.
    if (brandIdStr && !row.brandIds.includes(brandIdStr)) {
      return res.status(404).json({ error: "Lead not found" });
    }

    // Same campaign-identity resolution the list does, so a campaign-scoped panel reads the whole
    // identity's delivery evidence and not just the live campaign row's (see flattenFamilyStatus).
    const campaignFamily = campaignIdStr
      ? await resolveCampaignFamily(campaignIdStr, {
          orgId: req.orgId!,
          userId: req.userId ?? null,
          runId: req.runId ?? null,
          brandId: brandIdStr ?? null,
        })
      : null;
    const scopeCampaignIds = campaignFamily ?? (campaignIdStr ? [campaignIdStr] : null);
    const familySet =
      scopeCampaignIds && scopeCampaignIds.length > 1 ? new Set(scopeCampaignIds) : null;
    const flatten = familySet
      ? (result: StatusResult) => flattenFamilyStatus(result, familySet)
      : campaignIdStr
        ? flattenCampaignStatus
        : flattenBrandStatus;

    const fullLeadByLeadId = await buildFullLeadsBatch([row.leadId]);
    const fullLead = fullLeadByLeadId.get(row.leadId) ?? null;
    const emailContact = fullLead?.contacts.find((c) => c.channel === "email");
    const email = emailContact ? { value: emailContact.value, status: emailContact.status } : null;

    const audienceMap = await buildAudienceMapForRows(
      [{ leadId: row.leadId, email: email?.value ?? null, audienceId: row.audienceId, brandIds: row.brandIds }],
      brandIdStr,
      { orgId: req.orgId!, userId: req.userId ?? null, runId: req.runId ?? null },
    );

    // One row, so the resolver's memoization buys nothing here — it exists so this route emits the
    // same offer, resolved the same way, as the list element for the same row.
    const offerMap = await createOfferCardResolver({
      orgId: req.orgId!,
      userId: req.userId ?? null,
      runId: req.runId ?? null,
      brandId: brandIdStr ?? null,
    }).resolve([row.campaignId]);

    // Same rule as the list: evidence is only fetched for a served row in a named scope, so an
    // unserved row (or an unscoped read) carries the same all-false overlay it does there.
    let deliveryStatus: FlattenedStatus = DEFAULT_STATUS;
    let statusResult: StatusResult | null = null;
    if ((brandIdStr || campaignIdStr) && row.status === "served" && email?.value) {
      const response = await checkDeliveryStatus(
        row.brandIds[0] ?? "unknown",
        statusCampaignId(scopeCampaignIds),
        [{ email: email.value }],
        getServiceContext(req),
      );
      statusResult = response.results.find((r) => r.email === email.value) ?? null;
      deliveryStatus = statusResult ? flatten(statusResult) : DEFAULT_STATUS;
    }

    // One row, so nothing is memoized — the resolver exists here so the panel reads the SAME
    // standing, resolved the same way, as the list element for the same row.
    const standingMap = await resolveStandings(
      createLeadStandingResolver({
        orgId: req.orgId!,
        userId: req.userId ?? null,
        runId: req.runId ?? null,
        brandId: brandIdStr ?? null,
        deliveryQueried: !!(brandIdStr || campaignIdStr),
      }),
      [
        {
          id: row.id,
          leadId: row.leadId,
          campaignId: row.campaignId,
          brandIds: row.brandIds,
          status: row.status,
          delivery: standingDelivery(deliveryStatus),
        },
      ],
    );

    // The nested campaign cards. Built from the SAME gateway answer the row above was flattened
    // from — one delivery call, whichever way it is read.
    const campaigns = includeCampaigns
      ? ((
          await createCampaignBreakdownResolver({
            scope: {
              orgId: req.orgId!,
              brandId: brandIdStr,
              campaignId: campaignIdStr,
              campaignIds: scopeCampaignIds ?? undefined,
            },
            orgId: req.orgId!,
            userId: req.userId ?? null,
            runId: req.runId ?? null,
            brandId: brandIdStr ?? null,
            deliveryQueried: !!(brandIdStr || campaignIdStr),
            offerResolver: createOfferCardResolver({
              orgId: req.orgId!,
              userId: req.userId ?? null,
              runId: req.runId ?? null,
              brandId: brandIdStr ?? null,
            }),
            singleCampaignScopeId: statusCampaignId(scopeCampaignIds) ?? null,
          }).resolve(
            [{ id: row.id, leadId: row.leadId, email: email?.value ?? null, delivery: deliveryStatus }],
            statusResult ? new Map([[email!.value, statusResult]]) : new Map(),
          )
        ).get(row.id) ?? [])
      : null;

    return res.json({
      leadDetail: serializeLeadItem(
        row,
        fullLead,
        email,
        audienceMap.get(row.leadId) ?? null,
        offerMap.get(row.campaignId) ?? null,
        deliveryStatus,
        standingMap.get(row.id) ?? unresolvedFacts(),
        campaigns,
      ),
    });
  } catch (error) {
    console.error("[lead-service] Lead detail error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
