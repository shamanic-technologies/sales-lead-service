import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { SOURCE_FOUND_STATUS_REASON } from "./source-stock.js";
import type { SourceAudienceJudge } from "./source-stock-belongs.js";

/**
 * A SOURCE'S WHOLE STOCK, ASKED AGAIN WHETHER EACH FIND IS ITS OWN (LEAK-1012 part 2, 2026-10-13).
 *
 * The handover asks it one find at a time (src/lib/source-stock.ts). A stock filled before the rules held must not
 * wait for a pipe to reach each wrong row: `recheckSourceStock` asks the same judge (src/lib/source-stock-belongs.ts)
 * per audience of the stock and sets every find of an audience that is not this source's aside, with the judge's
 * reason, exactly as the handover would. Rows already handed or set aside are never touched.
 *
 * `adoptSetAsideFinds` gives such finds to the source they DO belong to: a find another source set aside, never handed
 * (nobody contacted them through it), whose audience the receiving source's judge accepts, is filed under the
 * receiving source as its own find (`status_reason = 'source_found'`), oldest first by its original find time. The
 * original row stays set aside (its history). One person once per source: a person the receiving source already
 * holds is skipped. The handover's still-fits question still applies to every adopted find.
 */

export interface StockAudienceCount {
  audienceId: string | null;
  inStock: number;
}

export interface StockRecheck {
  sourceCampaignId: string;
  dryRun: boolean;
  before: StockAudienceCount[];
  setAside: Array<{ audienceId: string; rows: number; reason: string }>;
  after: StockAudienceCount[];
}

async function stockByAudience(orgId: string, sourceCampaignId: string): Promise<StockAudienceCount[]> {
  const rows = (await db.execute(sql`
    SELECT audience_id, count(*)::int AS n
      FROM leads_campaigns
     WHERE org_id = ${orgId}
       AND campaign_id = ${sourceCampaignId}
       AND status_reason = ${SOURCE_FOUND_STATUS_REASON}
       AND status = 'served'
       AND source_handed_at IS NULL
       AND source_set_aside_at IS NULL
     GROUP BY audience_id
     ORDER BY audience_id NULLS LAST
  `)) as unknown as Array<{ audience_id: string | null; n: number }>;
  return rows.map((r) => ({ audienceId: r.audience_id, inStock: Number(r.n) }));
}

export async function recheckSourceStock(params: {
  orgId: string;
  sourceCampaignId: string;
  dryRun: boolean;
  judge: SourceAudienceJudge;
}): Promise<StockRecheck> {
  const before = await stockByAudience(params.orgId, params.sourceCampaignId);
  const setAside: StockRecheck["setAside"] = [];
  for (const { audienceId, inStock } of before) {
    // A find without an audience fails its handover loudly (src/lib/source-stock.ts); nothing to judge it on here.
    if (!audienceId) continue;
    const verdict = await params.judge(params.sourceCampaignId, audienceId);
    if (verdict.belongs) continue;
    if (params.dryRun) {
      setAside.push({ audienceId, rows: inStock, reason: verdict.reason });
      continue;
    }
    const updated = (await db.execute(sql`
      UPDATE leads_campaigns
         SET source_set_aside_at = now(), source_set_aside_reason = ${verdict.reason}, updated_at = now()
       WHERE org_id = ${params.orgId}
         AND campaign_id = ${params.sourceCampaignId}
         AND audience_id = ${audienceId}
         AND status_reason = ${SOURCE_FOUND_STATUS_REASON}
         AND status = 'served'
         AND source_handed_at IS NULL
         AND source_set_aside_at IS NULL
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    setAside.push({ audienceId, rows: updated.length, reason: verdict.reason });
    console.warn(
      `[lead-service] source stock recheck set aside ${updated.length} finds: sourceCampaign=${params.sourceCampaignId} audience=${audienceId} reason="${verdict.reason}"`,
    );
  }
  const after = params.dryRun ? before : await stockByAudience(params.orgId, params.sourceCampaignId);
  return { sourceCampaignId: params.sourceCampaignId, dryRun: params.dryRun, before, setAside, after };
}

export interface StockAdoption {
  sourceCampaignId: string;
  fromSourceCampaignId: string;
  dryRun: boolean;
  /** Per audience of the other source's set-aside, never-handed finds: how many this source took, or why not. */
  audiences: Array<{ audienceId: string; candidates: number; adopted: number; refusedReason: string | null }>;
  before: StockAudienceCount[];
  after: StockAudienceCount[];
}

export async function adoptSetAsideFinds(params: {
  orgId: string;
  sourceCampaignId: string;
  fromSourceCampaignId: string;
  dryRun: boolean;
  judge: SourceAudienceJudge;
}): Promise<StockAdoption> {
  const before = await stockByAudience(params.orgId, params.sourceCampaignId);
  const groups = (await db.execute(sql`
    SELECT audience_id, count(*)::int AS n
      FROM leads_campaigns
     WHERE org_id = ${params.orgId}
       AND campaign_id = ${params.fromSourceCampaignId}
       AND status_reason = ${SOURCE_FOUND_STATUS_REASON}
       AND status = 'served'
       AND source_handed_at IS NULL
       AND source_set_aside_at IS NOT NULL
       AND audience_id IS NOT NULL
     GROUP BY audience_id
     ORDER BY audience_id
  `)) as unknown as Array<{ audience_id: string; n: number }>;

  const audiences: StockAdoption["audiences"] = [];
  for (const g of groups) {
    const verdict = await params.judge(params.sourceCampaignId, g.audience_id);
    if (!verdict.belongs) {
      audiences.push({ audienceId: g.audience_id, candidates: Number(g.n), adopted: 0, refusedReason: verdict.reason });
      continue;
    }
    if (params.dryRun) {
      audiences.push({ audienceId: g.audience_id, candidates: Number(g.n), adopted: 0, refusedReason: null });
      continue;
    }
    const inserted = (await db.execute(sql`
      INSERT INTO leads_campaigns (
        lead_id, campaign_id, org_id, brand_ids, status, status_reason, status_details, served_at,
        parent_run_id, run_id, push_run_id, user_id, workflow_slug, feature_slug, goal, active_goal_id,
        brand_profile_id, audience_id, buying_signal, person_id
      )
      SELECT s.lead_id, ${params.sourceCampaignId}, s.org_id, s.brand_ids, 'served', ${SOURCE_FOUND_STATUS_REASON},
             'Re-filed from source campaign ' || s.campaign_id || ' (row ' || s.id || '), set aside there: ' || s.source_set_aside_reason,
             s.served_at, s.parent_run_id, s.run_id, s.push_run_id, s.user_id, s.workflow_slug, s.feature_slug, s.goal,
             s.active_goal_id, s.brand_profile_id, s.audience_id, s.buying_signal, s.person_id
        FROM leads_campaigns s
       WHERE s.org_id = ${params.orgId}
         AND s.campaign_id = ${params.fromSourceCampaignId}
         AND s.audience_id = ${g.audience_id}
         AND s.status_reason = ${SOURCE_FOUND_STATUS_REASON}
         AND s.status = 'served'
         AND s.source_handed_at IS NULL
         AND s.source_set_aside_at IS NOT NULL
       ORDER BY COALESCE(s.served_at, s.created_at) ASC, s.id ASC
      ON CONFLICT (lead_id, campaign_id) DO NOTHING
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    audiences.push({ audienceId: g.audience_id, candidates: Number(g.n), adopted: inserted.length, refusedReason: null });
    console.log(
      `[lead-service] source stock adoption: sourceCampaign=${params.sourceCampaignId} took ${inserted.length}/${g.n} set-aside finds of audience=${g.audience_id} from sourceCampaign=${params.fromSourceCampaignId}`,
    );
  }
  const after = params.dryRun ? before : await stockByAudience(params.orgId, params.sourceCampaignId);
  return { sourceCampaignId: params.sourceCampaignId, fromSourceCampaignId: params.fromSourceCampaignId, dryRun: params.dryRun, audiences, before, after };
}
