import { Router } from "express";
import { eq, and, sql, type SQL } from "drizzle-orm";
import { type AuthenticatedRequest, apiKeyAuth, requireOrgId, getServiceContext } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { leadsCampaigns, leads, leadContactMethods } from "../db/schema.js";
import {
  checkDeliveryStatus,
  type StatusResult,
  type DeliveryStatusItem,
  type ScopedStatus,
  type GlobalStatus,
} from "../lib/email-gateway-client.js";
import { traceEvent } from "../lib/trace-event.js";

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

router.get("/orgs/leads", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  try {
    if (req.runId) {
      traceEvent(req.runId, { service: "lead-service", event: "leads-query-start", detail: `orgId=${req.orgId}` }, req.headers).catch(() => {});
    }

    const { brandId, campaignId, orgId: queryOrgId, userId } = req.query;
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

    const rows = await db
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
        leadApolloPersonId: leads.apolloPersonId,
        leadFirstName: leads.firstName,
        leadLastName: leads.lastName,
        leadName: leads.name,
        leadHeadline: leads.headline,
        leadLinkedinUrl: leads.linkedinUrl,
        leadCity: leads.city,
        leadState: leads.state,
        leadCountry: leads.country,
        leadMetadata: leads.metadata,
      })
      .from(leadsCampaigns)
      .leftJoin(leads, eq(leads.id, leadsCampaigns.leadId))
      .where(and(...conditions));

    // Fetch primary email per leadId in a single query
    const leadIds = Array.from(new Set(rows.map((r) => r.leadId)));
    const emailRows = leadIds.length === 0
      ? []
      : await db.execute<{ lead_id: string; value: string; status: string | null }>(sql`
          SELECT DISTINCT ON (lead_id) lead_id, value, status
          FROM lead_contact_methods
          WHERE channel = 'email'
            AND lead_id = ANY(${sql.raw(`ARRAY[${leadIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(",") || "NULL"}]::uuid[]`)})
          ORDER BY lead_id, created_at DESC
        `);
    const emailByLead = new Map<string, { value: string; status: string | null }>();
    for (const row of emailRows as unknown as Array<{ lead_id: string; value: string; status: string | null }>) {
      emailByLead.set(row.lead_id, { value: row.value, status: row.status });
    }

    const campaignIdStr = typeof campaignId === "string" ? campaignId : undefined;
    const brandIdStr = typeof brandId === "string" ? brandId : undefined;
    const hasScopeForStatus = !!(campaignIdStr || brandIdStr);
    const flatten = campaignIdStr ? flattenCampaignStatus : flattenBrandStatus;
    const context = getServiceContext(req);

    const statusMap = new Map<string, StatusResult>();
    if (hasScopeForStatus) {
      const groups = new Map<string, { brandId: string; items: DeliveryStatusItem[] }>();
      for (const row of rows) {
        if (row.status !== "served") continue;
        const email = emailByLead.get(row.leadId)?.value;
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

    const allLeads = rows.map((row) => {
      const email = emailByLead.get(row.leadId);
      const emailValue = email?.value ?? "";
      const emailStatus = email?.status ?? null;
      const statusResult = statusMap.get(emailValue);
      const deliveryStatus = hasScopeForStatus && row.status === "served"
        ? (statusResult ? flatten(statusResult) : DEFAULT_STATUS)
        : DEFAULT_STATUS;

      const enrichment = row.leadFirstName || row.leadLastName || row.leadHeadline || row.leadMetadata
        ? {
            firstName: row.leadFirstName ?? undefined,
            lastName: row.leadLastName ?? undefined,
            name: row.leadName ?? undefined,
            headline: row.leadHeadline ?? undefined,
            linkedinUrl: row.leadLinkedinUrl ?? undefined,
            city: row.leadCity ?? undefined,
            state: row.leadState ?? undefined,
            country: row.leadCountry ?? undefined,
            ...(row.leadMetadata && typeof row.leadMetadata === "object"
              ? (row.leadMetadata as Record<string, unknown>)
              : {}),
          }
        : null;

      return {
        id: row.id,
        leadId: row.leadId,
        namespace: "apollo",
        email: emailValue,
        apolloPersonId: row.leadApolloPersonId ?? null,
        metadata: row.leadMetadata,
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
        enrichment,
        statusReason: row.statusReason ?? null,
        statusDetails: row.statusDetails ?? null,
        ...deliveryStatus,
      };
    });

    if (req.runId) {
      traceEvent(req.runId, { service: "lead-service", event: "leads-query-done", detail: `count=${allLeads.length}`, data: { count: allLeads.length } }, req.headers).catch(() => {});
    }
    res.json({ leads: allLeads });
  } catch (error) {
    console.error("[lead-service] Leads error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
