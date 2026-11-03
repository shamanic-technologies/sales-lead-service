-- ONE-FOLLOWUP-PER-LEAD-1103 (owner 2026-11-03: « une fiche ne doit pas etre par campaign mais par lead, non????? »).
-- The reactive follow-up queue read WHEN a person is due off each leads_campaigns row; Doc Dinners 2026-11-02: Thomas
-- was answered by the meeting-booking campaign on its own row (next follow-up 11-05), then claimed again 61 s later
-- through his cold-email row, still due "now": two replies. From now on WHEN is the person's ONE date at the brand
-- (lead_followup_dates): every row statement states it, every claim takes it (basis 'not_yet' = the lease's end).
-- No DDL here: a long backup COPY holds a share lock on the table and an ALTER would hold boot behind it.
-- Collapse: per (org, brand, lead) holding an open row debt, the date following the MOST RECENT action wins. A row's
-- statement time is its last write (`updated_at`: every follow-up statement and claim stamps it); the person date's is
-- its latest send, statement, serve or stop. The row's due date replaces the person's only when that row was written
-- after the person date last moved, so nobody becomes due earlier than their latest action implied (Thomas: a send at
-- 2026-11-03 05:26 moved his date to 11-10, after both rows were written on 11-02: 11-10 stands).
WITH open_debts AS (
  SELECT lc.org_id, b AS brand_id, lc.lead_id, lc.followup_due_at AS due_at, lc.updated_at AS written_at,
         lc.followup_due_set_by_campaign_id AS set_by
  FROM leads_campaigns lc CROSS JOIN LATERAL unnest(lc.brand_ids) AS b
  WHERE lc.followup_due_at IS NOT NULL AND lc.org_id IS NOT NULL AND b IS NOT NULL AND b <> ''
), latest AS (
  SELECT DISTINCT ON (org_id, brand_id, lead_id) org_id, brand_id, lead_id, due_at, written_at, set_by
  FROM open_debts
  ORDER BY org_id, brand_id, lead_id, written_at DESC, due_at DESC
)
INSERT INTO lead_followup_dates AS d (org_id, brand_id, lead_id, next_followup_at, basis, reason, stated_by_campaign_id, stated_at)
SELECT org_id, brand_id, lead_id, due_at, 'stated', 'Collapsed from the per-campaign follow-up rows (ONE-FOLLOWUP-PER-LEAD-1103)', set_by, written_at
FROM latest
ON CONFLICT (org_id, brand_id, lead_id) DO UPDATE SET
  next_followup_at = EXCLUDED.next_followup_at, basis = 'stated', reason = EXCLUDED.reason,
  stated_by_campaign_id = EXCLUDED.stated_by_campaign_id, stated_at = EXCLUDED.stated_at, stated_run_id = NULL,
  stopped_at = NULL, updated_at = now()
WHERE GREATEST(d.last_sent_at, d.stated_at, d.last_served_at, d.stopped_at) IS NULL
   OR GREATEST(d.last_sent_at, d.stated_at, d.last_served_at, d.stopped_at) < EXCLUDED.stated_at;
