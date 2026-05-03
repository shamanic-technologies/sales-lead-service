import { Router } from "express";
import { eq, and, sql, type SQL } from "drizzle-orm";
import { type AuthenticatedRequest, apiKeyAuth, requireOrgId, getServiceContext } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { servedLeads, leadBuffer } from "../db/schema.js";
import {
  checkDeliveryStatus,
  type StatusResult,
  type DeliveryStatusItem,
  type ScopedStatus,
  type GlobalStatus,
} from "../lib/email-gateway-client.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

export function extractEnrichment(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object") return null;
  const m = metadata as Record<string, unknown>;
  // Only return enrichment if at least one person field exists
  if (!m.firstName && !m.lastName && !m.email) return null;
  // Pass through all fields from Apollo — no filtering
  return { ...m };
}

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
  global: {
    bounced: boolean;
    unsubscribed: boolean;
  };
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

/**
 * Flatten status using campaign scope (when campaignId is provided).
 * Also checks brand + global for contacted flag.
 */
export function flattenCampaignStatus(result: StatusResult): FlattenedStatus {
  const bc = result.broadcast;
  const tx = result.transactional;

  const bcCampaign = pickScoped(bc?.campaign);
  const txCampaign = pickScoped(tx?.campaign);
  const merged = mergeProviders(bcCampaign, txCampaign);

  // contacted: also true if brand or global says contacted
  if (bc?.brand?.contacted || tx?.brand?.contacted) {
    merged.contacted = true;
  }

  const global = mergeGlobal(bc?.global, tx?.global);

  return { ...merged, global };
}

/**
 * Flatten status using brand scope (when no campaignId — cross-campaign view).
 */
export function flattenBrandStatus(result: StatusResult): FlattenedStatus {
  const bc = result.broadcast;
  const tx = result.transactional;

  const bcBrand = pickScoped(bc?.brand);
  const txBrand = pickScoped(tx?.brand);
  const merged = mergeProviders(bcBrand, txBrand);

  const global = mergeGlobal(bc?.global, tx?.global);

  return { ...merged, global };
}

const DEFAULT_STATUS: FlattenedStatus = {
  contacted: false, sent: false, delivered: false, opened: false, clicked: false,
  bounced: false, unsubscribed: false, replied: false, replyClassification: null, lastDeliveredAt: null,
  global: { bounced: false, unsubscribed: false },
};

router.get("/orgs/leads", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  try {
    if (req.runId) traceEvent(req.runId, { service: "lead-service", event: "leads-query-start", detail: `orgId=${req.orgId}` }, req.headers).catch(() => {});
    const { brandId, campaignId, orgId, userId } = req.query;

    // Build filter conditions for served_leads
    const servedConditions: SQL[] = [eq(servedLeads.orgId, req.orgId!)];
    // Build filter conditions for lead_buffer
    const bufferConditions: SQL[] = [eq(leadBuffer.orgId, req.orgId!)];

    if (brandId && typeof brandId === "string") {
      servedConditions.push(sql`${brandId} = ANY(${servedLeads.brandIds})`);
      bufferConditions.push(sql`${brandId} = ANY(${leadBuffer.brandIds})`);
    }
    if (campaignId && typeof campaignId === "string") {
      servedConditions.push(eq(servedLeads.campaignId, campaignId));
      bufferConditions.push(eq(leadBuffer.campaignId, campaignId));
    }
    if (orgId && typeof orgId === "string") {
      servedConditions.push(eq(servedLeads.orgId, orgId));
      bufferConditions.push(eq(leadBuffer.orgId, orgId));
    }
    if (userId && typeof userId === "string") {
      servedConditions.push(eq(servedLeads.userId, userId));
      bufferConditions.push(eq(leadBuffer.userId, userId));
    }

    // Get served leads and buffer entries in parallel
    const [servedRows, bufferRows] = await Promise.all([
      db.query.servedLeads.findMany({
        where: and(...servedConditions),
      }),
      db.query.leadBuffer.findMany({
        where: and(...bufferConditions),
      }),
    ]);

    // Fetch delivery status from email-gateway (only for served leads)
    const campaignIdStr = typeof campaignId === "string" ? campaignId : undefined;
    const brandIdStr = typeof brandId === "string" ? brandId : undefined;
    const hasScopeForStatus = !!(campaignIdStr || brandIdStr);
    const flatten = campaignIdStr ? flattenCampaignStatus : flattenBrandStatus;
    const context = getServiceContext(req);

    let statusMap = new Map<string, StatusResult>();

    if (hasScopeForStatus) {
      // Group by first brandId since email-gateway scopes status per brand
      const groups = new Map<string, { brandId: string; items: DeliveryStatusItem[] }>();
      for (const row of servedRows) {
        if (!row.leadId) continue;
        const primaryBrandId = row.brandIds[0] ?? "unknown";
        if (!groups.has(primaryBrandId)) {
          groups.set(primaryBrandId, { brandId: primaryBrandId, items: [] });
        }
        groups.get(primaryBrandId)!.items.push({ email: row.email });
      }

      await Promise.all(
        Array.from(groups.values()).map(async (group) => {
          const response = await checkDeliveryStatus(
            group.brandId,
            campaignIdStr,
            group.items,
            context,
          );
          for (const result of response.results) {
            statusMap.set(result.email, result);
          }
        }),
      );
    }

    // Map served leads
    const enrichedServed = servedRows.map((lead) => {
      const statusResult = statusMap.get(lead.email);
      const deliveryStatus = hasScopeForStatus
        ? (statusResult ? flatten(statusResult) : DEFAULT_STATUS)
        : DEFAULT_STATUS;

      const enrichment = extractEnrichment(lead.metadata);
      const emailStatus = (enrichment?.emailStatus as string) ?? null;

      return {
        ...lead,
        status: "served" as const,
        leadId: lead.leadId ?? null,
        apolloPersonId: lead.apolloPersonId ?? null,
        emailStatus,
        enrichment,
        statusReason: null,
        statusDetails: null,
        ...deliveryStatus,
      };
    });

    // Map buffer entries
    const enrichedBuffer = bufferRows.map((row) => {
      const enrichment = extractEnrichment(row.data);
      const emailStatus = (enrichment?.emailStatus as string) ?? null;

      return {
        id: row.id,
        leadId: null,
        namespace: row.namespace,
        email: row.email,
        apolloPersonId: row.apolloPersonId ?? null,
        metadata: row.data,
        parentRunId: null,
        runId: null,
        brandIds: row.brandIds ?? [],
        campaignId: row.campaignId,
        orgId: row.orgId,
        userId: row.userId ?? null,
        workflowSlug: row.workflowSlug ?? null,
        featureSlug: row.featureSlug ?? null,
        servedAt: null,
        status: row.status as "buffered" | "skipped" | "claimed",
        emailStatus,
        enrichment,
        statusReason: row.statusReason ?? null,
        statusDetails: row.statusDetails ?? null,
        ...DEFAULT_STATUS,
      };
    });

    const allLeads = [...enrichedServed, ...enrichedBuffer];

    if (req.runId) traceEvent(req.runId, { service: "lead-service", event: "leads-query-done", detail: `count=${allLeads.length}`, data: { count: allLeads.length, served: enrichedServed.length, buffered: enrichedBuffer.length } }, req.headers).catch(() => {});
    res.json({ leads: allLeads });
  } catch (error) {
    console.error("[lead-service] Leads error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
