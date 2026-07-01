import { Router } from "express";
import { type AuthenticatedRequest, apiKeyAuth, requireOrgId, getServiceContext } from "../middleware/auth.js";
import { sql } from "../db/index.js";
import {
  checkDeliveryStatus,
  type StatusResult,
  type DeliveryStatusItem,
  type ScopedStatus,
  type GlobalStatus,
} from "../lib/email-gateway-client.js";
import { traceEvent } from "../lib/trace-event.js";
import { buildFullLeadsBatch, type FullLead } from "../lib/lead-shape.js";
import { streamBasicLeadChunks, toIsoTimestamp, type BasicLeadRow } from "../lib/basic-leads.js";
import { leadCampaignBaseRelation, type LeadListScope } from "../lib/lead-list-query.js";
import { resolveAudiencesForBrand, type AudienceCard, type AudienceResolveContext } from "../lib/audience-client.js";

const router = Router();

interface FlattenedStatus {
  contacted: boolean;
  sent: boolean;
  delivered: boolean;
  opened: boolean;
  clicked: boolean;
  bounced: boolean;
  unsubscribed: boolean;
  replied: boolean;
  replyClassification: "positive" | "negative" | "neutral" | null;
  lastDeliveredAt: string | null;
  firstContactedAt: string | null;
  firstSentAt: string | null;
  firstDeliveredAt: string | null;
  firstOpenedAt: string | null;
  firstClickedAt: string | null;
  firstRepliedAt: string | null;
  firstBouncedAt: string | null;
  firstUnsubscribedAt: string | null;
  global: { bounced: boolean; unsubscribed: boolean };
}

/** First-occurrence (MIN) merge: earliest non-null ISO timestamp across providers. */
function earliestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

function pickScoped(s: ScopedStatus | null | undefined) {
  return {
    contacted: !!s?.contacted,
    sent: !!s?.sent,
    delivered: !!s?.delivered,
    opened: !!s?.opened,
    clicked: !!s?.clicked,
    bounced: !!s?.bounced,
    unsubscribed: !!s?.unsubscribed,
    replied: !!s?.replied,
    replyClassification: s?.replyClassification ?? null,
    lastDeliveredAt: s?.lastDeliveredAt ?? null,
    firstContactedAt: s?.firstContactedAt ?? null,
    firstSentAt: s?.firstSentAt ?? null,
    firstDeliveredAt: s?.firstDeliveredAt ?? null,
    firstOpenedAt: s?.firstOpenedAt ?? null,
    firstClickedAt: s?.firstClickedAt ?? null,
    firstRepliedAt: s?.firstRepliedAt ?? null,
    firstBouncedAt: s?.firstBouncedAt ?? null,
    firstUnsubscribedAt: s?.firstUnsubscribedAt ?? null,
  };
}

function mergeGlobal(bc?: GlobalStatus | null, tx?: GlobalStatus | null) {
  return {
    bounced: !!(bc?.email?.bounced || tx?.email?.bounced),
    unsubscribed: !!(bc?.email?.unsubscribed || tx?.email?.unsubscribed),
  };
}

function mergeProviders(
  bcScope: ReturnType<typeof pickScoped>,
  txScope: ReturnType<typeof pickScoped>,
): Omit<FlattenedStatus, "global"> {
  return {
    contacted: bcScope.contacted || txScope.contacted,
    sent: bcScope.sent || txScope.sent,
    delivered: bcScope.delivered || txScope.delivered,
    opened: bcScope.opened || txScope.opened,
    clicked: bcScope.clicked || txScope.clicked,
    bounced: bcScope.bounced || txScope.bounced,
    unsubscribed: bcScope.unsubscribed || txScope.unsubscribed,
    replied: bcScope.replied || txScope.replied,
    replyClassification: bcScope.replyClassification ?? txScope.replyClassification ?? null,
    lastDeliveredAt: bcScope.lastDeliveredAt ?? txScope.lastDeliveredAt ?? null,
    firstContactedAt: earliestIso(bcScope.firstContactedAt, txScope.firstContactedAt),
    firstSentAt: earliestIso(bcScope.firstSentAt, txScope.firstSentAt),
    firstDeliveredAt: earliestIso(bcScope.firstDeliveredAt, txScope.firstDeliveredAt),
    firstOpenedAt: earliestIso(bcScope.firstOpenedAt, txScope.firstOpenedAt),
    firstClickedAt: earliestIso(bcScope.firstClickedAt, txScope.firstClickedAt),
    firstRepliedAt: earliestIso(bcScope.firstRepliedAt, txScope.firstRepliedAt),
    firstBouncedAt: earliestIso(bcScope.firstBouncedAt, txScope.firstBouncedAt),
    firstUnsubscribedAt: earliestIso(bcScope.firstUnsubscribedAt, txScope.firstUnsubscribedAt),
  };
}

export function flattenCampaignStatus(result: StatusResult): FlattenedStatus {
  const bc = result.broadcast;
  const tx = result.transactional;
  const merged = mergeProviders(pickScoped(bc?.campaign), pickScoped(tx?.campaign));
  if (bc?.brand?.contacted || tx?.brand?.contacted) merged.contacted = true;
  return { ...merged, global: mergeGlobal(bc?.global, tx?.global) };
}

export function flattenBrandStatus(result: StatusResult): FlattenedStatus {
  const bc = result.broadcast;
  const tx = result.transactional;
  const merged = mergeProviders(pickScoped(bc?.brand), pickScoped(tx?.brand));
  return { ...merged, global: mergeGlobal(bc?.global, tx?.global) };
}

const DEFAULT_STATUS: FlattenedStatus = {
  contacted: false, sent: false, delivered: false, opened: false, clicked: false,
  bounced: false, unsubscribed: false, replied: false, replyClassification: null, lastDeliveredAt: null,
  firstContactedAt: null, firstSentAt: null, firstDeliveredAt: null, firstOpenedAt: null,
  firstClickedAt: null, firstRepliedAt: null, firstBouncedAt: null, firstUnsubscribedAt: null,
  global: { bounced: false, unsubscribed: false },
};

// A single brand can carry 50k+ leads_campaigns rows. Loading every row before
// streaming still OOMs even if hydration/JSON writes are chunked. Read, hydrate,
// overlay delivery status, and serialize one chunk at a time so peak memory is
// bounded by LEADS_STREAM_CHUNK_SIZE regardless of the brand's lead count.
// The wire shape is byte-identical to the old res.json({ leads }) — `{"leads":[...]}`.
const LEADS_STREAM_CHUNK_SIZE = Math.max(1, Number(process.env.LEADS_STREAM_CHUNK_SIZE) || 500);

interface LeadCampaignCursor {
  createdAt: Date;
  id: string;
}

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
  created_at: Date;
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
  createdAt: Date;
  leadApolloPersonId: string | null;
}

// Brand/org scope collapses leads_campaigns to one row per lead_id (see
// leadCampaignBaseRelation); campaign scope stays flat. Keyset-paginate the DEDUPED
// relation by (created_at, id) so dedup is GLOBAL, not per-chunk. Scope filters live
// both inside the dedup subquery (so the winner is chosen within scope) and on the
// outer WHERE (required for the non-deduped campaign path; a no-op for the dedup path).
async function fetchLeadCampaignChunk(
  scope: LeadListScope,
  cursor: LeadCampaignCursor | null,
): Promise<LeadCampaignRow[]> {
  const rows = await sql<RawLeadCampaignRow[]>`
    SELECT
      lc.id, lc.lead_id, lc.campaign_id, lc.org_id, lc.user_id, lc.brand_ids,
      lc.status, lc.status_reason, lc.status_details, lc.parent_run_id, lc.run_id,
      lc.served_at, lc.workflow_slug, lc.feature_slug, lc.goal, lc.active_goal_id,
      lc.brand_profile_id, lc.audience_id, lc.created_at,
      l.apollo_person_id AS lead_apollo_person_id
    FROM ${leadCampaignBaseRelation(scope)}
    LEFT JOIN leads l ON l.id = lc.lead_id
    WHERE lc.org_id = ${scope.orgId}
      ${scope.brandId ? sql`AND ${scope.brandId} = ANY(lc.brand_ids)` : sql``}
      ${scope.campaignId ? sql`AND lc.campaign_id = ${scope.campaignId}` : sql``}
      ${scope.queryOrgId ? sql`AND lc.org_id = ${scope.queryOrgId}` : sql``}
      ${scope.userId ? sql`AND lc.user_id = ${scope.userId}` : sql``}
      ${scope.workflowSlug ? sql`AND lc.workflow_slug = ${scope.workflowSlug}` : sql``}
      ${cursor ? sql`AND (lc.created_at, lc.id) > (${cursor.createdAt}, ${cursor.id})` : sql``}
    ORDER BY lc.created_at ASC, lc.id ASC
    LIMIT ${LEADS_STREAM_CHUNK_SIZE}
  `;

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
    leadApolloPersonId: r.lead_apollo_person_id,
  }));
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

router.get("/orgs/leads", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  let streamingStarted = false;
  try {
    if (req.runId) {
      traceEvent(req.runId, { service: "lead-service", event: "leads-query-start", detail: `orgId=${req.orgId}` }, req.headers).catch(() => {});
    }

    const { brandId, campaignId, orgId: queryOrgId, userId, workflowSlug } = req.query;
    const campaignIdStr = typeof campaignId === "string" ? campaignId : undefined;
    const brandIdStr = typeof brandId === "string" ? brandId : undefined;
    const queryOrgIdStr = typeof queryOrgId === "string" ? queryOrgId : undefined;
    const userIdStr = typeof userId === "string" ? userId : undefined;
    const workflowSlugStr = typeof workflowSlug === "string" ? workflowSlug : undefined;

    // One shared scope for both the slim (`?view=basic`) and full paths. Brand/org
    // scope is collapsed to one row per lead_id downstream; campaign scope stays flat.
    const scope: LeadListScope = {
      orgId: req.orgId!,
      brandId: brandIdStr,
      campaignId: campaignIdStr,
      queryOrgId: queryOrgIdStr,
      userId: userIdStr,
      workflowSlug: workflowSlugStr,
    };

    const hasScopeForStatus = !!(campaignIdStr || brandIdStr);
    const flatten = campaignIdStr ? flattenCampaignStatus : flattenBrandStatus;
    const context = getServiceContext(req);
    const audienceCtx: AudienceResolveContext = {
      orgId: req.orgId!,
      userId: req.userId ?? null,
      runId: req.runId ?? null,
    };
    // `?view=basic` => slim per-lead payload. Anything else (incl. absent) => full
    // FullLead, the existing default. No Zod default: a missing param is full.
    const slim = req.query.view === "basic";

    // Basic view: ONE flat query (current-employer org + primary email via LATERAL),
    // streamed in cursor chunks. This keeps the list shape compatible with api-service
    // while avoiding the "load a whole large brand before first byte" failure mode.
    if (slim) {
      res.setHeader("Content-Type", "application/json");
      res.write('{"leads":[');
      streamingStarted = true;

      let wroteFirstBasic = false;
      let rowCount = 0;
      for await (const basicRows of streamBasicLeadChunks(scope, LEADS_STREAM_CHUNK_SIZE)) {
        rowCount += basicRows.length;

        const statusMap = hasScopeForStatus
          ? await buildStatusMapForBasicRows(basicRows, campaignIdStr, context)
          : new Map<string, StatusResult>();

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

        for (const r of basicRows) {
          const emailValue = r.email?.value ?? "";
          const emailStatus = r.email?.status ?? null;
          const statusResult = statusMap.get(emailValue);
          const deliveryStatus = hasScopeForStatus && r.status === "served"
            ? (statusResult ? flatten(statusResult) : DEFAULT_STATUS)
            : DEFAULT_STATUS;

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
            audienceId: r.audienceId ?? null,
            audience: audienceMap.get(r.leadId) ?? null,
            servedAt: r.servedAt,
            status: r.status as "buffered" | "skipped" | "claimed" | "served",
            emailStatus,
            lead: r.lead,
            statusReason: r.statusReason ?? null,
            statusDetails: r.statusDetails ?? null,
            ...deliveryStatus,
          };

          res.write((wroteFirstBasic ? "," : "") + JSON.stringify(leadOut));
          wroteFirstBasic = true;
        }
      }

      res.write("]}");
      res.end();

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
    res.write('{"leads":[');
    streamingStarted = true;

    let wroteFirst = false;
    let cursor: LeadCampaignCursor | null = null;
    let rowCount = 0;
    while (true) {
      const chunkRows = await fetchLeadCampaignChunk(scope, cursor);
      if (chunkRows.length === 0) break;
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

      // Delivery-status overlay, scoped to this chunk's served rows only.
      const statusMap = new Map<string, StatusResult>();
      if (hasScopeForStatus) {
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
            const response = await checkDeliveryStatus(group.brandId, campaignIdStr, group.items, context);
            for (const result of response.results) statusMap.set(result.email, result);
          }),
        );
      }

      for (const row of chunkRows) {
        const fullLead = fullLeadByLeadId.get(row.leadId) ?? null;
        const email = primaryEmail(fullLead ?? undefined);
        const emailValue = email?.value ?? "";
        const emailStatus = email?.status ?? null;
        const statusResult = statusMap.get(emailValue);
        const deliveryStatus = hasScopeForStatus && row.status === "served"
          ? (statusResult ? flatten(statusResult) : DEFAULT_STATUS)
          : DEFAULT_STATUS;

        const leadOut = {
          id: row.id,
          leadId: row.leadId,
          namespace: "apollo",
          email: emailValue,
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
          audienceId: row.audienceId ?? null,
          audience: audienceMap.get(row.leadId) ?? null,
          servedAt: row.servedAt,
          status: row.status as "buffered" | "skipped" | "claimed" | "served",
          emailStatus,
          lead: fullLead,
          statusReason: row.statusReason ?? null,
          statusDetails: row.statusDetails ?? null,
          ...deliveryStatus,
        };

        res.write((wroteFirst ? "," : "") + JSON.stringify(leadOut));
        wroteFirst = true;
      }

      const lastRow = chunkRows[chunkRows.length - 1];
      cursor = { createdAt: lastRow.createdAt, id: lastRow.id };
    }

    res.write("]}");
    res.end();

    if (req.runId) {
      traceEvent(req.runId, { service: "lead-service", event: "leads-query-done", detail: `count=${rowCount}`, data: { count: rowCount } }, req.headers).catch(() => {});
    }
  } catch (error) {
    console.error("[lead-service] Leads error:", error);
    if (streamingStarted || res.headersSent) {
      // Stream already open — can't send a 500 body. Destroy the socket so the caller
      // sees a truncated/aborted response and treats it as a failure (fail loud).
      res.destroy(error instanceof Error ? error : new Error(String(error)));
    } else {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

export default router;
