-- STALE-OWED-1119: an occurrence debt (open grant) whose person a LATER claim already took through another row of the
-- brand (any acting campaign) is closed, as the claim now does in its own statement. Positive evidence only: the
-- `claimed` ledger row (followup_actions), dated at or after the debt came due and was stated. A claim whose run failed
-- kept its own row due, so the person stays owed there. Idempotent: only still-open grants are touched.
UPDATE leads_campaigns s
   SET followup_stated_closed_at = c.claimed_at,
       followup_due_at = NULL,
       followup_stopped_reason = 'answered_through_another_campaign',
       updated_at = now()
  FROM (
    SELECT s2.id, min(fa.occurred_at) AS claimed_at
      FROM leads_campaigns s2
      JOIN followup_actions fa
        ON fa.action = 'claimed' AND fa.lead_id = s2.lead_id AND fa.org_id = s2.org_id
       AND fa.lead_campaign_id <> s2.id AND fa.brand_ids && s2.brand_ids
       AND fa.occurred_at >= s2.followup_due_at AND fa.occurred_at >= s2.followup_stated_at
     WHERE s2.followup_stated_event_id IS NOT NULL AND s2.followup_stated_closed_at IS NULL
       AND s2.followup_due_at IS NOT NULL AND s2.followup_claimed_at IS NULL
     GROUP BY s2.id
  ) c
 WHERE s.id = c.id
   AND s.followup_stated_event_id IS NOT NULL AND s.followup_stated_closed_at IS NULL AND s.followup_due_at IS NOT NULL;
