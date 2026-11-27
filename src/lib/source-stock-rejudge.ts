import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { askAudienceFit } from "./audience-fit-client.js";
import { contactOf } from "./lead-followup-date.js";
import { SOURCE_FOUND_STATUS_REASON, type AudienceFitVerdict } from "./source-stock.js";

/**
 * A FIND SET ASIDE BECAUSE ITS AUDIENCE COULD NOT JUDGE IT IS JUDGED AGAIN (GMAPS-SET-ASIDE-1127-REOPEN, 2026-11-27).
 *
 * At handover (src/lib/source-stock.ts) a find human-service cannot judge (still-fits 422: "this audience never found
 * this person...") is set aside in its words, with its code in `source_set_aside_cannot_judge`. That is not a verdict:
 * once the audience CAN answer (Living Vital's Google Maps audience: 289 pharmacies set aside, 0 emailed, until
 * human-service learnt to judge them), each such find is asked again:
 *   - fits now           -> back in the source's stock (set-aside cleared), handed on as any find; the handover asks
 *                           still-fits (and whether it is the source's own) again before handing;
 *   - no longer fits     -> stays set aside with the new reason, mark cleared: a real verdict, never re-opened;
 *   - still cannot judge -> stays set aside with the new words and code, asked again later.
 * A find set aside for a real reason (no longer fits, not this source's, not owed) carries no mark and is never touched.
 * human-service unreachable / unreadable = the pass stops there, the row stays as it was.
 *
 * Re-asked by the background sweep (each find at most once per `REJUDGE_AGAIN_AFTER_MS`) and on demand per source
 * (`POST /internal/source-campaigns/{id}/stock/rejudge`, `dryRun`). Idempotent: a re-opened find holds no mark any more.
 */

export const REJUDGE_AGAIN_AFTER_MS = 24 * 60 * 60 * 1000;
export const REJUDGE_SWEEP_BATCH = 500;
const REJUDGE_SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 90 * 1000;

export type AskStillFits = (question: {
  orgId: string;
  audienceId: string;
  brandId: string;
  email: string | null;
  phone?: string;
  personId: string | null;
}) => Promise<AudienceFitVerdict>;

export interface RejudgeOutcome {
  dryRun: boolean;
  asked: number;
  /** Back in the source's stock. */
  reopened: number;
  /** A real verdict now: stays set aside with this reason. */
  noLongerFits: Array<{ reason: string; rows: number }>;
  /** Still cannot judge: stays set aside, asked again later. */
  stillCannotJudge: Array<{ code: string; rows: number }>;
  /** A find whose lead holds neither email nor phone: nothing to ask with, left untouched. */
  noContact: number;
}

interface CannotJudgeRow {
  id: string;
  org_id: string;
  brand_id: string | null;
  lead_id: string;
  audience_id: string;
  person_id: string | null;
}

const realAsk: AskStillFits = ({ orgId, ...q }) => askAudienceFit(q, { orgId });

function tally<K extends string>(list: Array<Record<K, string> & { rows: number }>, key: K, value: string): void {
  const hit = list.find((e) => e[key] === value);
  if (hit) hit.rows += 1;
  else list.push({ [key]: value, rows: 1 } as Record<K, string> & { rows: number });
}

export async function rejudgeCannotJudgeFinds(params: {
  dryRun: boolean;
  /** Narrow to one org's source (the route). Absent = every org (the sweep). */
  orgId?: string;
  sourceCampaignId?: string;
  /** Skip finds asked again less than this long ago (the sweep). Absent = ask every marked find. */
  askedBeforeMs?: number;
  limit?: number;
  ask?: AskStillFits;
}): Promise<RejudgeOutcome> {
  const ask = params.ask ?? realAsk;
  const rows = (await db.execute(sql`
    SELECT id, org_id, brand_ids[1] AS brand_id, lead_id, audience_id, person_id
      FROM leads_campaigns
     WHERE status_reason = ${SOURCE_FOUND_STATUS_REASON}
       AND status = 'served'
       AND source_handed_at IS NULL
       AND source_set_aside_at IS NOT NULL
       AND source_set_aside_cannot_judge IS NOT NULL
       AND audience_id IS NOT NULL
       ${params.orgId ? sql`AND org_id = ${params.orgId}` : sql``}
       ${params.sourceCampaignId ? sql`AND campaign_id = ${params.sourceCampaignId}` : sql``}
       ${params.askedBeforeMs !== undefined
         ? sql`AND (source_set_aside_rejudged_at IS NULL OR source_set_aside_rejudged_at < ${new Date(Date.now() - params.askedBeforeMs).toISOString()}::timestamptz)`
         : sql``}
     ORDER BY source_set_aside_rejudged_at ASC NULLS FIRST, source_set_aside_at ASC, id ASC
     ${params.limit ? sql`LIMIT ${params.limit}` : sql``}
  `)) as unknown as CannotJudgeRow[];

  const outcome: RejudgeOutcome = { dryRun: params.dryRun, asked: 0, reopened: 0, noLongerFits: [], stillCannotJudge: [], noContact: 0 };
  for (const row of rows) {
    if (!row.brand_id) throw new Error(`[source-stock-rejudge] find ${row.id} carries no brand`);
    const contact = await contactOf(db, row.lead_id);
    if (!contact.email && !contact.phone) {
      outcome.noContact += 1;
      continue;
    }
    const verdict = await ask({
      orgId: row.org_id,
      audienceId: row.audience_id,
      brandId: row.brand_id,
      email: contact.email,
      ...(contact.email ? {} : { phone: contact.phone as string }),
      personId: row.person_id,
    });
    outcome.asked += 1;
    if (verdict.fits) outcome.reopened += 1;
    else if (verdict.cannotJudge) tally(outcome.stillCannotJudge, "code", verdict.cannotJudge);
    else tally(outcome.noLongerFits, "reason", verdict.reason);
    if (params.dryRun) continue;

    // Guarded on the row still being a marked, unhanded set-aside: a handover or another pass in between wins.
    const guard = sql`id = ${row.id} AND source_handed_at IS NULL AND source_set_aside_at IS NOT NULL AND source_set_aside_cannot_judge IS NOT NULL`;
    if (verdict.fits) {
      await db.execute(sql`
        UPDATE leads_campaigns
           SET source_set_aside_at = NULL, source_set_aside_reason = NULL, source_set_aside_cannot_judge = NULL,
               source_set_aside_rejudged_at = now(), updated_at = now()
         WHERE ${guard}
      `);
      console.log(`[lead-service] source stock re-judge: find ${row.id} (audience=${row.audience_id}, lead=${row.lead_id}) fits now, back in stock`);
    } else {
      await db.execute(sql`
        UPDATE leads_campaigns
           SET source_set_aside_reason = ${verdict.reason}, source_set_aside_cannot_judge = ${verdict.cannotJudge ?? null},
               source_set_aside_rejudged_at = now(), updated_at = now()
         WHERE ${guard}
      `);
    }
  }
  if (outcome.asked > 0 || outcome.noContact > 0) {
    console.log(
      `[lead-service] source stock re-judge${params.dryRun ? " (dry run)" : ""}: asked=${outcome.asked} reopened=${outcome.reopened} noLongerFits=${JSON.stringify(outcome.noLongerFits)} stillCannotJudge=${JSON.stringify(outcome.stillCannotJudge)} noContact=${outcome.noContact}`,
    );
  }
  return outcome;
}

let rejudging = false;

/** Background thread: every marked find asked again at most once a day, a bounded batch per pass. */
export function startSourceStockRejudgeWorker(): void {
  const tick = async () => {
    if (rejudging) return;
    rejudging = true;
    try {
      await rejudgeCannotJudgeFinds({ dryRun: false, askedBeforeMs: REJUDGE_AGAIN_AFTER_MS, limit: REJUDGE_SWEEP_BATCH });
    } catch (err) {
      console.error("[lead-service] source stock re-judge sweep failed:", err);
    } finally {
      rejudging = false;
    }
  };
  setTimeout(() => void tick(), FIRST_TICK_DELAY_MS).unref();
  setInterval(() => void tick(), REJUDGE_SWEEP_INTERVAL_MS).unref();
}
