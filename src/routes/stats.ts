import { Router } from "express";
import { eq, and, count, inArray, sql, type SQL } from "drizzle-orm";
import { type AuthenticatedRequest, apiKeyAuth, requireOrgId, getServiceContext } from "../middleware/auth.js";
import { db } from "../db/index.js";
import { leadsCampaigns } from "../db/schema.js";
import {
  fetchEmailGatewayStats,
  type RecipientStats,
  type EmailGatewayStatsResponse,
  type EmailGatewayGroupedStatsResponse,
} from "../lib/email-gateway-client.js";
import {
  resolveFeatureDynastySlugs,
  resolveWorkflowDynastySlugs,
  fetchFeatureDynastyMap,
  fetchWorkflowDynastyMap,
} from "../lib/dynasty-client.js";

const VALID_GROUP_BY = [
  "campaignId",
  "brandId",
  "workflowSlug",
  "featureSlug",
  "workflowDynastySlug",
  "featureDynastySlug",
] as const;
type GroupByField = (typeof VALID_GROUP_BY)[number];

const COLUMN_MAP = {
  campaignId: leadsCampaigns.campaignId,
  workflowSlug: leadsCampaigns.workflowSlug,
  featureSlug: leadsCampaigns.featureSlug,
} as const;

const EG_GROUP_BY_MAP: Record<string, string> = {
  campaignId: "campaignId",
  brandId: "brandId",
  workflowSlug: "workflowSlug",
  featureSlug: "featureSlug",
};

const router = Router();

async function resolveDynastySlugs(
  req: AuthenticatedRequest,
): Promise<{ workflowSlugs: string[] | null; featureSlugs: string[] | null; emptyDynasty: boolean }> {
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const workflowDynastySlug = str(req.query.workflowDynastySlug);
  const featureDynastySlug = str(req.query.featureDynastySlug);
  const workflowSlug = str(req.query.workflowSlug);
  const workflowSlugsParam = str(req.query.workflowSlugs);
  const featureSlug = str(req.query.featureSlug);
  const featureSlugsParam = str(req.query.featureSlugs);

  const context = { orgId: req.orgId, userId: req.userId, runId: req.runId };
  let workflowSlugs: string[] | null = null;
  let featureSlugs: string[] | null = null;

  if (workflowDynastySlug) {
    workflowSlugs = await resolveWorkflowDynastySlugs(workflowDynastySlug, context);
    if (workflowSlugs.length === 0) return { workflowSlugs: [], featureSlugs: null, emptyDynasty: true };
  } else if (workflowSlugsParam) {
    workflowSlugs = workflowSlugsParam.split(",").filter(Boolean);
  } else if (workflowSlug) {
    workflowSlugs = [workflowSlug];
  }

  if (featureDynastySlug) {
    featureSlugs = await resolveFeatureDynastySlugs(featureDynastySlug, context);
    if (featureSlugs.length === 0) return { workflowSlugs, featureSlugs: [], emptyDynasty: true };
  } else if (featureSlugsParam) {
    featureSlugs = featureSlugsParam.split(",").filter(Boolean);
  } else if (featureSlug) {
    featureSlugs = [featureSlug];
  }

  return { workflowSlugs, featureSlugs, emptyDynasty: false };
}

function buildConditions(req: AuthenticatedRequest, dynastyResolved: { workflowSlugs: string[] | null; featureSlugs: string[] | null }) {
  const { brandId, campaignId, orgId, userId, runIds } = req.query;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const brandIdStr = str(brandId);
  const campaignIdStr = str(campaignId);
  const orgIdStr = str(orgId);
  const userIdStr = str(userId);
  const runIdList = typeof runIds === "string" ? runIds.split(",").filter(Boolean) : [];

  const conds: SQL[] = [eq(leadsCampaigns.orgId, req.orgId!)];
  if (brandIdStr) conds.push(sql`${brandIdStr} = ANY(${leadsCampaigns.brandIds})`);
  if (campaignIdStr) conds.push(eq(leadsCampaigns.campaignId, campaignIdStr));
  if (orgIdStr) conds.push(eq(leadsCampaigns.orgId, orgIdStr));
  if (userIdStr) conds.push(eq(leadsCampaigns.userId, userIdStr));
  if (runIdList.length > 0) {
    conds.push(
      sql`(${leadsCampaigns.parentRunId} = ANY(ARRAY[${sql.join(runIdList.map((id) => sql`${id}`), sql`, `)}]) OR ${leadsCampaigns.runId} = ANY(ARRAY[${sql.join(runIdList.map((id) => sql`${id}`), sql`, `)}]) OR ${leadsCampaigns.pushRunId} = ANY(ARRAY[${sql.join(runIdList.map((id) => sql`${id}`), sql`, `)}]))`,
    );
  }
  if (dynastyResolved.workflowSlugs && dynastyResolved.workflowSlugs.length > 0) {
    conds.push(inArray(leadsCampaigns.workflowSlug, dynastyResolved.workflowSlugs));
  }
  if (dynastyResolved.featureSlugs && dynastyResolved.featureSlugs.length > 0) {
    conds.push(inArray(leadsCampaigns.featureSlug, dynastyResolved.featureSlugs));
  }
  return { conds, runIdList, brandIdStr, campaignIdStr, orgIdStr };
}

const ZERO_RECIPIENT_STATS: RecipientStats = {
  contacted: 0, sent: 0, delivered: 0, opened: 0, bounced: 0, clicked: 0,
  unsubscribed: 0, repliesPositive: 0, repliesNegative: 0, repliesNeutral: 0,
  repliesAutoReply: 0,
  repliesDetail: {
    interested: 0, meetingBooked: 0, closed: 0, notInterested: 0,
    wrongPerson: 0, unsubscribe: 0, neutral: 0, autoReply: 0, outOfOffice: 0,
  },
};

type GroupStats = { totalLeads: number; byOutreachStatus: RecipientStats; repliesDetail: RecipientStats["repliesDetail"]; buffered: number; skipped: number; claimed: number };

function newGroupStats(): GroupStats {
  return {
    totalLeads: 0,
    byOutreachStatus: { ...ZERO_RECIPIENT_STATS, repliesDetail: { ...ZERO_RECIPIENT_STATS.repliesDetail } },
    repliesDetail: { ...ZERO_RECIPIENT_STATS.repliesDetail },
    buffered: 0,
    skipped: 0,
    claimed: 0,
  };
}

function mergeRecipientStats(broadcast?: { recipientStats: RecipientStats }, transactional?: { recipientStats: RecipientStats }): { byOutreachStatus: RecipientStats; repliesDetail: RecipientStats["repliesDetail"] } {
  const bc = broadcast?.recipientStats ?? ZERO_RECIPIENT_STATS;
  const tx = transactional?.recipientStats ?? ZERO_RECIPIENT_STATS;
  const byOutreachStatus: RecipientStats = {
    contacted: bc.contacted + tx.contacted,
    sent: bc.sent + tx.sent,
    delivered: bc.delivered + tx.delivered,
    opened: bc.opened + tx.opened,
    bounced: bc.bounced + tx.bounced,
    clicked: bc.clicked + tx.clicked,
    unsubscribed: bc.unsubscribed + tx.unsubscribed,
    repliesPositive: bc.repliesPositive + tx.repliesPositive,
    repliesNegative: bc.repliesNegative + tx.repliesNegative,
    repliesNeutral: bc.repliesNeutral + tx.repliesNeutral,
    repliesAutoReply: bc.repliesAutoReply + tx.repliesAutoReply,
    repliesDetail: {
      interested: (bc.repliesDetail?.interested ?? 0) + (tx.repliesDetail?.interested ?? 0),
      meetingBooked: (bc.repliesDetail?.meetingBooked ?? 0) + (tx.repliesDetail?.meetingBooked ?? 0),
      closed: (bc.repliesDetail?.closed ?? 0) + (tx.repliesDetail?.closed ?? 0),
      notInterested: (bc.repliesDetail?.notInterested ?? 0) + (tx.repliesDetail?.notInterested ?? 0),
      wrongPerson: (bc.repliesDetail?.wrongPerson ?? 0) + (tx.repliesDetail?.wrongPerson ?? 0),
      unsubscribe: (bc.repliesDetail?.unsubscribe ?? 0) + (tx.repliesDetail?.unsubscribe ?? 0),
      neutral: (bc.repliesDetail?.neutral ?? 0) + (tx.repliesDetail?.neutral ?? 0),
      autoReply: (bc.repliesDetail?.autoReply ?? 0) + (tx.repliesDetail?.autoReply ?? 0),
      outOfOffice: (bc.repliesDetail?.outOfOffice ?? 0) + (tx.repliesDetail?.outOfOffice ?? 0),
    },
  };
  return { byOutreachStatus, repliesDetail: byOutreachStatus.repliesDetail };
}

function applyStatusCounts(group: GroupStats, status: string, n: number) {
  if (status === "served") group.totalLeads += n;
  else if (status === "buffered") group.buffered += n;
  else if (status === "skipped") group.skipped += n;
  else if (status === "claimed") group.claimed += n;
}

const ZERO_STATS = { groups: [] };

router.get("/orgs/stats", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  try {
    const groupByParam = typeof req.query.groupBy === "string" ? req.query.groupBy : undefined;
    if (groupByParam && !VALID_GROUP_BY.includes(groupByParam as GroupByField)) {
      res.status(400).json({ error: `Invalid groupBy value. Allowed: ${VALID_GROUP_BY.join(", ")}` });
      return;
    }

    const dynastyResolved = await resolveDynastySlugs(req);
    if (dynastyResolved.emptyDynasty) {
      if (groupByParam) {
        res.json(ZERO_STATS);
      } else {
        res.json({
          totalLeads: 0,
          byOutreachStatus: ZERO_RECIPIENT_STATS,
          repliesDetail: ZERO_RECIPIENT_STATS.repliesDetail,
          buffered: 0,
          skipped: 0,
          claimed: 0,
        });
      }
      return;
    }

    const conds = buildConditions(req, dynastyResolved);
    const egContext = getServiceContext(req);

    const egParams: Parameters<typeof fetchEmailGatewayStats>[0] = {};
    if (conds.brandIdStr) egParams.brandId = conds.brandIdStr;
    if (conds.campaignIdStr) egParams.campaignId = conds.campaignIdStr;
    if (dynastyResolved.workflowSlugs) egParams.workflowSlugs = dynastyResolved.workflowSlugs.join(",");
    if (dynastyResolved.featureSlugs) egParams.featureSlugs = dynastyResolved.featureSlugs.join(",");

    if (groupByParam === "workflowDynastySlug" || groupByParam === "featureDynastySlug") {
      const isWorkflow = groupByParam === "workflowDynastySlug";
      const dbField = isWorkflow ? "workflowSlug" : "featureSlug";
      const col = COLUMN_MAP[dbField];
      const context = { orgId: req.orgId, userId: req.userId, runId: req.runId };
      egParams.groupBy = dbField;

      const [dynastyMap, statusRows, egStats] = await Promise.all([
        isWorkflow ? fetchWorkflowDynastyMap(context) : fetchFeatureDynastyMap(context),
        db
          .select({ key: col, status: leadsCampaigns.status, count: count() })
          .from(leadsCampaigns)
          .where(and(...conds.conds))
          .groupBy(col, leadsCampaigns.status),
        fetchEmailGatewayStats(egParams, egContext),
      ]);

      const groups = new Map<string, GroupStats>();
      const toDynasty = (slug: string | null): string => dynastyMap.get(slug ?? "") ?? slug ?? "unknown";
      const getGroup = (key: string) => {
        if (!groups.has(key)) groups.set(key, newGroupStats());
        return groups.get(key)!;
      };

      for (const row of statusRows) {
        const dynastyKey = toDynasty(row.key);
        applyStatusCounts(getGroup(dynastyKey), row.status, row.count);
      }
      if ("groups" in egStats) {
        for (const g of (egStats as EmailGatewayGroupedStatsResponse).groups) {
          const dynastyKey = toDynasty(g.key);
          const group = getGroup(dynastyKey);
          const merged = mergeRecipientStats(g.broadcast, g.transactional);
          for (const k of Object.keys(merged.byOutreachStatus) as (keyof RecipientStats)[]) {
            if (k === "repliesDetail") continue;
            (group.byOutreachStatus[k] as number) += merged.byOutreachStatus[k] as number;
          }
          for (const k of Object.keys(merged.repliesDetail) as (keyof RecipientStats["repliesDetail"])[]) {
            (group.repliesDetail[k] as number) += merged.repliesDetail[k] as number;
            (group.byOutreachStatus.repliesDetail[k] as number) += merged.repliesDetail[k] as number;
          }
        }
      }
      res.json({ groups: Array.from(groups.entries()).map(([key, stats]) => ({ key, ...stats })) });
      return;
    }

    if (groupByParam === "brandId") {
      egParams.groupBy = "brandId";
      const [statusRows, egStats] = await Promise.all([
        db.execute<{ key: string; status: string; count: number }>(sql`
          SELECT unnest(brand_ids) AS key, status, COUNT(*)::int AS count
          FROM leads_campaigns
          WHERE ${and(...conds.conds)}
          GROUP BY key, status
        `),
        fetchEmailGatewayStats(egParams, egContext),
      ]);

      const groups = new Map<string, GroupStats>();
      const getGroup = (key: string | null) => {
        const k = key ?? "unknown";
        if (!groups.has(k)) groups.set(k, newGroupStats());
        return groups.get(k)!;
      };
      for (const row of statusRows as unknown as Array<{ key: string; status: string; count: number }>) {
        applyStatusCounts(getGroup(row.key), row.status, row.count);
      }
      if ("groups" in egStats) {
        for (const g of (egStats as EmailGatewayGroupedStatsResponse).groups) {
          const group = getGroup(g.key);
          const merged = mergeRecipientStats(g.broadcast, g.transactional);
          group.byOutreachStatus = merged.byOutreachStatus;
          group.repliesDetail = merged.repliesDetail;
        }
      }
      res.json({ groups: Array.from(groups.entries()).map(([key, stats]) => ({ key, ...stats })) });
      return;
    }

    if (groupByParam) {
      const field = groupByParam as keyof typeof COLUMN_MAP;
      const col = COLUMN_MAP[field];
      egParams.groupBy = EG_GROUP_BY_MAP[field] ?? field;

      const [statusRows, egStats] = await Promise.all([
        db
          .select({ key: col, status: leadsCampaigns.status, count: count() })
          .from(leadsCampaigns)
          .where(and(...conds.conds))
          .groupBy(col, leadsCampaigns.status),
        fetchEmailGatewayStats(egParams, egContext),
      ]);

      const groups = new Map<string, GroupStats>();
      const getGroup = (key: string | null) => {
        const k = key ?? "unknown";
        if (!groups.has(k)) groups.set(k, newGroupStats());
        return groups.get(k)!;
      };
      for (const row of statusRows) applyStatusCounts(getGroup(row.key), row.status, row.count);
      if ("groups" in egStats) {
        for (const g of (egStats as EmailGatewayGroupedStatsResponse).groups) {
          const group = getGroup(g.key);
          const merged = mergeRecipientStats(g.broadcast, g.transactional);
          group.byOutreachStatus = merged.byOutreachStatus;
          group.repliesDetail = merged.repliesDetail;
        }
      }
      res.json({ groups: Array.from(groups.entries()).map(([key, stats]) => ({ key, ...stats })) });
      return;
    }

    // Flat
    const [statusRows, egStats] = await Promise.all([
      db
        .select({ status: leadsCampaigns.status, count: count() })
        .from(leadsCampaigns)
        .where(and(...conds.conds))
        .groupBy(leadsCampaigns.status),
      fetchEmailGatewayStats(egParams, egContext),
    ]);

    const flat = newGroupStats();
    for (const row of statusRows) applyStatusCounts(flat, row.status, row.count);
    const egFlat = egStats as EmailGatewayStatsResponse;
    const merged = mergeRecipientStats(egFlat.broadcast, egFlat.transactional);
    flat.byOutreachStatus = merged.byOutreachStatus;
    flat.repliesDetail = merged.repliesDetail;

    res.json({
      totalLeads: flat.totalLeads,
      byOutreachStatus: flat.byOutreachStatus,
      repliesDetail: flat.repliesDetail,
      buffered: flat.buffered,
      skipped: flat.skipped,
      claimed: flat.claimed,
    });
  } catch (error) {
    console.error("[lead-service] Stats error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
