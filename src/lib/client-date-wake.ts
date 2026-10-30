/**
 * A CLIENT'S STATED DATE WAKES THE CAMPAIGN THAT STATED IT (CLIENT-DATE-WAKE-1030, owner 2026-10-30: « la date fixée
 * par Sophie devient l'échéance de sa campagne »).
 *
 * The client check-in pipes (reactive, on Lead event) answer an occurrence or the person their own queue owes. When the
 * writer decides "later" it states the next date on `lead_followup_dates` (the date's only store) and closes its queue
 * row `stopped`. For a PROSPECT that date is re-served by the "Lead follow-up due" population of the sourcing pipe; a
 * CLIENT is never re-served there (its verdict stops on `customer`), so nothing ever came back at the date: prod
 * 2026-10-29, Olive (Sepehr Vali) stated 19:30 UTC by "Client WhatsApp", nothing ran, nothing was due.
 *
 * Rule: a date STATED by a campaign (basis `stated`, `stated_by_campaign_id`) for a person who PAID the brand (the
 * `current_client` predicate's `paid`: a live, attributed sale at the brand on that row, the lead or a lead of the same
 * human) puts THAT campaign's row of the person due at that date, once the date has come, through the ordinary
 * `scheduled` statement. The campaign's owed read then wakes it and its claim re-judges who they are.
 *
 * Once per date: only a row untouched since the date came due (`updated_at < next_followup_at`) is woken, so a run
 * that handled it (any close, any refusal) is never woken again for the same date; a new stated date wakes again.
 * Prospects are untouched (paid excludes them), so their dates keep their one re-serve path.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { SALE_STEP } from "./closed-deal.js";
import { writeFollowupStatement } from "./followup-queue.js";

export const CLIENT_DATE_WAKE_INTERVAL_MS = 2 * 60_000;
const FIRST_TICK_DELAY_MS = 75_000;
const WAKE_BATCH = 200;
const SALE_SPELLINGS: string[] = [SALE_STEP, "purchase"];

export interface WakeCandidate {
  id: string;
  org_id: string;
  next_followup_at: string;
  stated_by_campaign_id: string;
}

/** The client rows whose stated date has come and that nothing has touched since. One statement. */
export async function loadClientDateWakes(limit = WAKE_BATCH): Promise<WakeCandidate[]> {
  return (await db.execute(sql`
    SELECT lc.id::text AS id, lc.org_id, d.next_followup_at::text AS next_followup_at, d.stated_by_campaign_id::text AS stated_by_campaign_id
    FROM lead_followup_dates d
    JOIN leads_campaigns lc
      ON lc.lead_id = d.lead_id AND lc.org_id = d.org_id AND lc.campaign_id = d.stated_by_campaign_id
     AND d.brand_id = ANY(lc.brand_ids)
    WHERE d.basis = 'stated'
      AND d.stated_by_campaign_id IS NOT NULL
      AND d.next_followup_at <= now()
      AND lc.followup_handed_at IS NULL
      AND lc.followup_due_at IS NULL
      AND lc.updated_at < d.next_followup_at
      AND EXISTS (
        SELECT 1 FROM conversion_events ce
        WHERE ce.org_id = d.org_id
          AND ce.brand_id = d.brand_id
          AND ce.event = ANY(${sql.param(SALE_SPELLINGS)}::text[])
          AND ce.attribution_status = 'attributed'
          AND ce.withdrawn_at IS NULL
          AND (
            ce.lead_campaign_id = lc.id
            OR ce.matched_lead_id = d.lead_id
            OR ce.matched_lead_id IN (
              SELECT l2.id FROM leads l1 JOIN leads l2 ON l2.human_id = l1.human_id
              WHERE l1.id = d.lead_id AND l1.human_id IS NOT NULL
            )
          )
      )
    ORDER BY d.next_followup_at
    LIMIT ${limit}
  `)) as unknown as WakeCandidate[];
}

/** Make each due client row owed again, as its campaign would by stating `scheduled` at the date. */
export async function wakeClientStatedDates(nowMs = Date.now()): Promise<{ woken: number; failed: number }> {
  const candidates = await loadClientDateWakes();
  let woken = 0;
  let failed = 0;
  for (const c of candidates) {
    try {
      await writeFollowupStatement({
        orgId: c.org_id,
        id: c.id,
        kind: "scheduled",
        dueAtIso: new Date(c.next_followup_at).toISOString(),
        reason: null,
        nowMs,
        actingCampaignId: c.stated_by_campaign_id,
      });
      woken += 1;
    } catch (err) {
      failed += 1;
      console.error(`[lead-service] client date wake: row ${c.id} (campaign ${c.stated_by_campaign_id}) could not be made due:`, err);
    }
  }
  if (woken > 0 || failed > 0) console.log(`[lead-service] client date wake: woken=${woken} failed=${failed} (CLIENT-DATE-WAKE-1030)`);
  return { woken, failed };
}

let waking = false;

export function startClientDateWakeWorker(): void {
  const tick = async () => {
    if (waking) return;
    waking = true;
    try {
      await wakeClientStatedDates();
    } catch (err) {
      console.error("[lead-service] client date wake sweep failed:", err);
    } finally {
      waking = false;
    }
  };
  setTimeout(() => void tick(), FIRST_TICK_DELAY_MS).unref();
  setInterval(() => void tick(), CLIENT_DATE_WAKE_INTERVAL_MS).unref();
}
