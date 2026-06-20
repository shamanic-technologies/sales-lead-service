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
  "goal",
  "activeGoalId",
  "brandProfileId",
  "audienceId",
] as const;
type GroupByField = (typeof VALID_GROUP_BY)[number];
type AttributionGroupByField = Extract<
  GroupByField,
  "goal" | "activeGoalId" | "brandProfileId" | "audienceId"
>;

const COLUMN_MAP = {
  campaignId: leadsCampaigns.campaignId,
  workflowSlug: leadsCampaigns.workflowSlug,
  featureSlug: leadsCampaigns.featureSlug,
  goal: leadsCampaigns.goal,
  activeGoalId: leadsCampaigns.activeGoalId,
  brandProfileId: leadsCampaigns.brandProfileId,
  audienceId: leadsCampaigns.audienceId,
} as const;

const ATTRIBUTION_GROUP_BY = new Set<AttributionGroupByField>([
  "goal",
  "activeGoalId",
  "brandProfileId",
  "audienceId",
]);

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
  const {
    brandId,
    campaignId,
    orgId,
    userId,
    runIds,
    goal,
    activeGoalId,
    brandProfileId,
    audienceId,
  } = req.query;
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  const brandIdStr = str(brandId);
  const campaignIdStr = str(campaignId);
  const orgIdStr = str(orgId);
  const userIdStr = str(userId);
  const goalStr = str(goal);
  const activeGoalIdStr = str(activeGoalId);
  const brandProfileIdStr = str(brandProfileId);
  const audienceIdStr = str(audienceId);
  const runIdList = typeof runIds === "string" ? runIds.split(",").filter(Boolean) : [];

  const conds: SQL[] = [eq(leadsCampaigns.orgId, req.orgId!)];
  if (brandIdStr) conds.push(sql`${brandIdStr} = ANY(${leadsCampaigns.brandIds})`);
  if (campaignIdStr) conds.push(eq(leadsCampaigns.campaignId, campaignIdStr));
  if (orgIdStr) conds.push(eq(leadsCampaigns.orgId, orgIdStr));
  if (userIdStr) conds.push(eq(leadsCampaigns.userId, userIdStr));
  if (goalStr) conds.push(eq(leadsCampaigns.goal, goalStr));
  if (activeGoalIdStr) conds.push(eq(leadsCampaigns.activeGoalId, activeGoalIdStr));
  if (brandProfileIdStr) conds.push(eq(leadsCampaigns.brandProfileId, brandProfileIdStr));
  if (audienceIdStr) conds.push(eq(leadsCampaigns.audienceId, audienceIdStr));
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
  return {
    conds,
    runIdList,
    brandIdStr,
    campaignIdStr,
    orgIdStr,
    hasAttributionFilter:
      !!goalStr ||
      !!activeGoalIdStr ||
      !!brandProfileIdStr ||
      !!audienceIdStr,
  };
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

function addRecipientStats(group: GroupStats, stats: RecipientStats) {
  for (const k of Object.keys(stats) as (keyof RecipientStats)[]) {
    if (k === "repliesDetail") continue;
    (group.byOutreachStatus[k] as number) += stats[k] as number;
  }
  for (const k of Object.keys(stats.repliesDetail) as (keyof RecipientStats["repliesDetail"])[]) {
    (group.repliesDetail[k] as number) += stats.repliesDetail[k] as number;
    (group.byOutreachStatus.repliesDetail[k] as number) += stats.repliesDetail[k] as number;
  }
}

function isAttributionGroupBy(field: string | undefined): field is AttributionGroupByField {
  return !!field && ATTRIBUTION_GROUP_BY.has(field as AttributionGroupByField);
}

interface StatusCountRow {
  key?: string | null;
  status: string;
  count: number;
}

interface RecipientEvidenceRow {
  id: string;
  campaignId: string;
  brandIds: string[];
  workflowSlug: string | null;
  featureSlug: string | null;
  goal: string | null;
  activeGoalId: string | null;
  brandProfileId: string | null;
  audienceId: string | null;
  email: string;
}

function normalizeGroupKey(
  groupBy: GroupByField,
  key: string | null | undefined,
  dynastyMap?: Map<string, string>,
): string | null {
  if ((key == null || key === "") && isAttributionGroupBy(groupBy)) return null;
  if (groupBy === "workflowDynastySlug" || groupBy === "featureDynastySlug") {
    return dynastyMap?.get(key ?? "") ?? key ?? "unknown";
  }
  return key ?? "unknown";
}

function groupKeysForEvidenceRow(
  row: RecipientEvidenceRow,
  groupBy: GroupByField | undefined,
  dynastyMap?: Map<string, string>,
): string[] {
  if (!groupBy) return ["__flat__"];
  if (groupBy === "brandId") return row.brandIds.length > 0 ? row.brandIds : ["unknown"];
  if (groupBy === "workflowDynastySlug") {
    return [normalizeGroupKey(groupBy, row.workflowSlug, dynastyMap) ?? "unknown"];
  }
  if (groupBy === "featureDynastySlug") {
    return [normalizeGroupKey(groupBy, row.featureSlug, dynastyMap) ?? "unknown"];
  }

  const value = row[groupBy as keyof RecipientEvidenceRow];
  if (typeof value !== "string" || value.length === 0) {
    return isAttributionGroupBy(groupBy) ? [] : ["unknown"];
  }
  return [value];
}

function getGroupedStats(
  groups: Map<string, GroupStats>,
  key: string,
): GroupStats {
  if (!groups.has(key)) groups.set(key, newGroupStats());
  return groups.get(key)!;
}

async function fetchStatusCounts(
  groupBy: GroupByField | undefined,
  conds: SQL[],
): Promise<StatusCountRow[]> {
  if (!groupBy) {
    const rows = await db
      .select({ status: leadsCampaigns.status, count: count() })
      .from(leadsCampaigns)
      .where(and(...conds))
      .groupBy(leadsCampaigns.status);
    return rows;
  }

  if (groupBy === "brandId") {
    const rows = await db.execute<{ key: string; status: string; count: number }>(sql`
      SELECT unnest(brand_ids) AS key, status, COUNT(*)::int AS count
      FROM leads_campaigns
      WHERE ${and(...conds)}
      GROUP BY key, status
    `);
    return rows as unknown as StatusCountRow[];
  }

  const col =
    groupBy === "workflowDynastySlug"
      ? leadsCampaigns.workflowSlug
      : groupBy === "featureDynastySlug"
        ? leadsCampaigns.featureSlug
        : COLUMN_MAP[groupBy as keyof typeof COLUMN_MAP];
  const rows = await db
    .select({ key: col, status: leadsCampaigns.status, count: count() })
    .from(leadsCampaigns)
    .where(and(...conds))
    .groupBy(col, leadsCampaigns.status);
  return rows;
}

async function fetchRecipientEvidenceRows(conds: SQL[]): Promise<RecipientEvidenceRow[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT
      leads_campaigns.id AS "id",
      leads_campaigns.campaign_id AS "campaignId",
      leads_campaigns.brand_ids AS "brandIds",
      leads_campaigns.workflow_slug AS "workflowSlug",
      leads_campaigns.feature_slug AS "featureSlug",
      leads_campaigns.goal AS "goal",
      leads_campaigns.active_goal_id AS "activeGoalId",
      leads_campaigns.brand_profile_id AS "brandProfileId",
      leads_campaigns.audience_id AS "audienceId",
      em.value AS "email"
    FROM leads_campaigns
    JOIN LATERAL (
      SELECT value
      FROM lead_contact_methods
      WHERE lead_contact_methods.lead_id = leads_campaigns.lead_id
        AND lead_contact_methods.channel = 'email'
      ORDER BY lead_contact_methods.created_at ASC NULLS LAST, lead_contact_methods.value ASC
      LIMIT 1
    ) em ON true
    WHERE ${and(...conds)}
      AND leads_campaigns.status = 'served'
      AND em.value IS NOT NULL
  `);
  return rows as unknown as RecipientEvidenceRow[];
}

async function buildRecipientStatsByCampaign(
  evidenceRows: RecipientEvidenceRow[],
  context: ReturnType<typeof getServiceContext>,
): Promise<Map<string, Map<string, RecipientStats>>> {
  const rowsByCampaign = new Map<string, RecipientEvidenceRow[]>();
  for (const row of evidenceRows) {
    if (!rowsByCampaign.has(row.campaignId)) rowsByCampaign.set(row.campaignId, []);
    rowsByCampaign.get(row.campaignId)!.push(row);
  }

  const out = new Map<string, Map<string, RecipientStats>>();
  await Promise.all(
    Array.from(rowsByCampaign.entries()).map(async ([campaignId, rows]) => {
      const primaryBrandId = rows.find((r) => r.brandIds.length > 0)?.brandIds[0];
      const stats = await fetchEmailGatewayStats(
        {
          campaignId,
          brandId: primaryBrandId,
          groupBy: "recipientEmail",
        },
        context,
      );
      const byEmail = new Map<string, RecipientStats>();
      if ("groups" in stats) {
        for (const group of (stats as EmailGatewayGroupedStatsResponse).groups) {
          const merged = mergeRecipientStats(group.broadcast, group.transactional);
          byEmail.set(group.key.toLowerCase(), merged.byOutreachStatus);
        }
      }
      out.set(campaignId, byEmail);
    }),
  );

  return out;
}

async function buildAttributionAwareStats(
  groupBy: GroupByField | undefined,
  conds: SQL[],
  context: ReturnType<typeof getServiceContext>,
  dynastyMap?: Map<string, string>,
): Promise<GroupStats | Map<string, GroupStats>> {
  const [statusRows, evidenceRows] = await Promise.all([
    fetchStatusCounts(groupBy, conds),
    fetchRecipientEvidenceRows(conds),
  ]);

  const recipientStatsByCampaign = await buildRecipientStatsByCampaign(evidenceRows, context);

  if (!groupBy) {
    const flat = newGroupStats();
    for (const row of statusRows) applyStatusCounts(flat, row.status, row.count);
    for (const row of evidenceRows) {
      const stats = recipientStatsByCampaign.get(row.campaignId)?.get(row.email.toLowerCase());
      if (stats) addRecipientStats(flat, stats);
    }
    return flat;
  }

  const groups = new Map<string, GroupStats>();
  for (const row of statusRows) {
    const key = normalizeGroupKey(groupBy, row.key, dynastyMap);
    if (key == null) continue;
    applyStatusCounts(getGroupedStats(groups, key), row.status, row.count);
  }

  for (const row of evidenceRows) {
    const stats = recipientStatsByCampaign.get(row.campaignId)?.get(row.email.toLowerCase());
    if (!stats) continue;
    for (const key of groupKeysForEvidenceRow(row, groupBy, dynastyMap)) {
      addRecipientStats(getGroupedStats(groups, key), stats);
    }
  }

  return groups;
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
    const groupBy = groupByParam as GroupByField | undefined;

    const egParams: Parameters<typeof fetchEmailGatewayStats>[0] = {};
    if (conds.brandIdStr) egParams.brandId = conds.brandIdStr;
    if (conds.campaignIdStr) egParams.campaignId = conds.campaignIdStr;
    if (dynastyResolved.workflowSlugs) egParams.workflowSlugs = dynastyResolved.workflowSlugs.join(",");
    if (dynastyResolved.featureSlugs) egParams.featureSlugs = dynastyResolved.featureSlugs.join(",");

    if (conds.hasAttributionFilter || isAttributionGroupBy(groupByParam)) {
      const dynastyContext = { orgId: req.orgId, userId: req.userId, runId: req.runId };
      const dynastyMap =
        groupBy === "workflowDynastySlug"
          ? await fetchWorkflowDynastyMap(dynastyContext)
          : groupBy === "featureDynastySlug"
            ? await fetchFeatureDynastyMap(dynastyContext)
            : undefined;
      const attributionStats = await buildAttributionAwareStats(groupBy, conds.conds, egContext, dynastyMap);
      if (attributionStats instanceof Map) {
        res.json({
          groups: Array.from(attributionStats.entries()).map(([key, stats]) => ({ key, ...stats })),
        });
      } else {
        res.json({
          totalLeads: attributionStats.totalLeads,
          byOutreachStatus: attributionStats.byOutreachStatus,
          repliesDetail: attributionStats.repliesDetail,
          buffered: attributionStats.buffered,
          skipped: attributionStats.skipped,
          claimed: attributionStats.claimed,
        });
      }
      return;
    }

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
