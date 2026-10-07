-- AI Instant Call acted on people the follow-up ledger never heard of.
--
-- The ring (instantly-service ring-rep-on-sales-interest) calls the brand's rep about a
-- sales-interest reply under the offer's AI Instant Call campaign (leg conversation_to_booking_call)
-- and never claims through the queue, so `followup_actions` held nothing for that campaign and
-- GET /orgs/leads/conversation-counts read 0 for it while it was placing calls. From now on the
-- ring records its act through POST /orgs/campaigns/{campaignId}/followup-actions/by-email.
--
-- History. Every placed (not failed) twilio-service call under an AI Instant Call campaign before
-- that door existed: one, 2026-10-07 11:24 UTC (twilio call 7cea19ff, campaign 29c5606a). Its ring
-- root run 0d16cbc9 (instantly-service / ai-instant-call) revealed Apollo person
-- 5ae17e1ca6da984ce79c6c51, which is lead bc60b495 (robert.burke@fondren.com), held on cold-email
-- campaign f7b1b610 row b9cfef98. Positive evidence, not timing. Earlier calls were billed to the
-- cold-email campaign itself (no AI Instant Call campaign existed yet) and stay unattributed.
-- Joined onto leads_campaigns, so an environment without that row (CI) inserts nothing;
-- `source_ref` = `run:<ring root run>`, the same key the live door writes, so re-running is a no-op
-- and a live retry of the same ring cannot double it.
INSERT INTO followup_actions
  (org_id, brand_ids, lead_campaign_id, lead_id, held_by_campaign_id, acting_campaign_id, run_id,
   action, occurred_at, source, source_ref)
SELECT lc.org_id, lc.brand_ids, lc.id, lc.lead_id, lc.campaign_id, v.acting, v.run_id,
       'acted', v.occurred_at::timestamptz, 'twilio_backfill', 'run:' || v.run_id
FROM (VALUES
  ('b9cfef98-f3c3-453b-bfa0-3c87d98cb70a', '29c5606a-4b86-49f9-8ca8-ed7ddcf894f4', '0d16cbc9-55c4-4c40-9cfb-3fc8734a60a4', '2026-10-07 11:24:00.188918+00')
) AS v(lcid, acting, run_id, occurred_at)
JOIN leads_campaigns lc ON lc.id = v.lcid::uuid
ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING;
