import { Router } from "express";
import { asc, eq, and, gt, or, sql, type SQL } from "drizzle-orm";
import { type AuthenticatedRequest, apiKeyAuth, requireOrgId, getServiceContext } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { leadsCampaigns, leads } from "../db/schema.js";
import {
  checkDeliveryStatus,
  type StatusResult,
  type DeliveryStatusItem,
  type ScopedStatus,
  type GlobalStatus,
} from "../lib/email-gateway-client.js";
import { traceEvent } from "../lib/trace-event.js";
import { buildFullLeadsBatch, type FullLead } from "../lib/lead-shape.js";

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
  global: { bounced: boolean; unsubscribed: boolean };
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
  global: { bounced: false, unsubscribed: false },
};

interface SlimLead {
  leadId: string;
  apolloPersonId: string | null;
  firstName: string;
  lastName: string;
  name: string | null;
  headline: string | null;
  linkedinUrl: string | null;
  photoUrl: string | null;
  organization: {
    id: string;
    name: string | null;
    logoUrl: string | null;
    primaryDomain: string | null;
    websiteUrl: string | null;
  } | null;
}

// Slim projection of FullLead for `?view=basic`. Drops the fields no consumer reads —
// employmentHistory, the ~34 extra organization columns, funding events — verified against
// features-service (revenue engine) + dashboard (leads table + detail panel). Cuts the wire
// payload ~10x (~150MB -> ~15MB for a 50k-lead brand), which is what callers actually choke
// on: features-service parses the whole body, the dashboard transfers it on a poll timer.
// `view` absent => full shape (unchanged, backward-compatible).
function toSlimLead(full: FullLead | null): SlimLead | null {
  if (!full) return null;
  const org = full.organization;
  return {
    leadId: full.leadId,
    apolloPersonId: full.apolloPersonId,
    firstName: full.firstName,
    lastName: full.lastName,
    name: full.name,
    headline: full.headline,
    linkedinUrl: full.linkedinUrl,
    photoUrl: full.photoUrl,
    organization: org
      ? {
          id: org.id,
          name: org.name,
          logoUrl: org.logoUrl,
          primaryDomain: org.primaryDomain,
          websiteUrl: org.websiteUrl,
        }
      : null,
  };
}

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

async function fetchLeadCampaignChunk(conditions: SQL[], cursor: LeadCampaignCursor | null) {
  const pagedConditions = cursor
    ? [
        ...conditions,
        or(
          gt(leadsCampaigns.createdAt, cursor.createdAt),
          and(eq(leadsCampaigns.createdAt, cursor.createdAt), gt(leadsCampaigns.id, cursor.id)),
        )!,
      ]
    : conditions;

  return db
    .select({
      id: leadsCampaigns.id,
      leadId: leadsCampaigns.leadId,
      campaignId: leadsCampaigns.campaignId,
      orgId: leadsCampaigns.orgId,
      userId: leadsCampaigns.userId,
      brandIds: leadsCampaigns.brandIds,
      status: leadsCampaigns.status,
      statusReason: leadsCampaigns.statusReason,
      statusDetails: leadsCampaigns.statusDetails,
      parentRunId: leadsCampaigns.parentRunId,
      runId: leadsCampaigns.runId,
      servedAt: leadsCampaigns.servedAt,
      workflowSlug: leadsCampaigns.workflowSlug,
      featureSlug: leadsCampaigns.featureSlug,
      createdAt: leadsCampaigns.createdAt,
      leadApolloPersonId: leads.apolloPersonId,
    })
    .from(leadsCampaigns)
    .leftJoin(leads, eq(leads.id, leadsCampaigns.leadId))
    .where(and(...pagedConditions))
    .orderBy(asc(leadsCampaigns.createdAt), asc(leadsCampaigns.id))
    .limit(LEADS_STREAM_CHUNK_SIZE);
}

router.get("/orgs/leads", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  let streamingStarted = false;
  try {
    if (req.runId) {
      traceEvent(req.runId, { service: "lead-service", event: "leads-query-start", detail: `orgId=${req.orgId}` }, req.headers).catch(() => {});
    }

    const { brandId, campaignId, orgId: queryOrgId, userId, workflowSlug } = req.query;
    const conditions: SQL[] = [eq(leadsCampaigns.orgId, req.orgId!)];
    if (brandId && typeof brandId === "string") {
      conditions.push(sql`${brandId} = ANY(${leadsCampaigns.brandIds})`);
    }
    if (campaignId && typeof campaignId === "string") {
      conditions.push(eq(leadsCampaigns.campaignId, campaignId));
    }
    if (queryOrgId && typeof queryOrgId === "string") {
      conditions.push(eq(leadsCampaigns.orgId, queryOrgId));
    }
    if (userId && typeof userId === "string") {
      conditions.push(eq(leadsCampaigns.userId, userId));
    }
    if (workflowSlug && typeof workflowSlug === "string") {
      conditions.push(eq(leadsCampaigns.workflowSlug, workflowSlug));
    }

    const primaryEmail = (lead: FullLead | undefined): { value: string; status: string | null } | null => {
      if (!lead) return null;
      const email = lead.contacts.find((c) => c.channel === "email");
      return email ? { value: email.value, status: email.status } : null;
    };

    const campaignIdStr = typeof campaignId === "string" ? campaignId : undefined;
    const brandIdStr = typeof brandId === "string" ? brandId : undefined;
    const hasScopeForStatus = !!(campaignIdStr || brandIdStr);
    const flatten = campaignIdStr ? flattenCampaignStatus : flattenBrandStatus;
    const context = getServiceContext(req);
    // `?view=basic` => slim per-lead payload (see toSlimLead). Anything else (incl. absent)
    // => full FullLead, the existing default. No Zod default: a missing param is full.
    const slim = req.query.view === "basic";

    // The DB query above is the last point a clean 500 can be sent. Everything below
    // writes to the socket; from here on, failures destroy the stream (headers are sent).
    res.setHeader("Content-Type", "application/json");
    res.write('{"leads":[');
    streamingStarted = true;

    let wroteFirst = false;
    let cursor: LeadCampaignCursor | null = null;
    let rowCount = 0;
    while (true) {
      const chunkRows = await fetchLeadCampaignChunk(conditions, cursor);
      if (chunkRows.length === 0) break;
      rowCount += chunkRows.length;
      const chunkLeadIds = Array.from(new Set(chunkRows.map((r) => r.leadId)));
      const fullLeadByLeadId = await buildFullLeadsBatch(chunkLeadIds);

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
          servedAt: row.servedAt ? row.servedAt.toISOString() : null,
          status: row.status as "buffered" | "skipped" | "claimed" | "served",
          emailStatus,
          lead: slim ? toSlimLead(fullLead) : fullLead,
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
