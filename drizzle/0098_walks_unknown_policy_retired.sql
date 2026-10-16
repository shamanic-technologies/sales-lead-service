-- CATCHALL-BOUNCE-1016 (2026-10-16): `valid_catch_all_and_unknown` is deprecated and behaves as `valid_and_catch_all`
-- (an address the verifier judged unknown is never emailed). The route normalizes the value before the source walk
-- reads or writes it, so the walk rows stored under the old value would never be read again: fold each into its
-- `valid_and_catch_all` twin (the later empty answer wins), then drop the old rows. Idempotent: a second run finds none.
INSERT INTO source_audience_walks (source_campaign_id, audience_id, accepted_emails, last_empty_at, last_empty_reason)
SELECT source_campaign_id, audience_id, 'valid_and_catch_all', last_empty_at, last_empty_reason
  FROM source_audience_walks
 WHERE accepted_emails = 'valid_catch_all_and_unknown'
ON CONFLICT (source_campaign_id, audience_id, accepted_emails)
DO UPDATE SET last_empty_at = EXCLUDED.last_empty_at, last_empty_reason = EXCLUDED.last_empty_reason
 WHERE source_audience_walks.last_empty_at < EXCLUDED.last_empty_at;
--> statement-breakpoint
DELETE FROM source_audience_walks WHERE accepted_emails = 'valid_catch_all_and_unknown';
