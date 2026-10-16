-- UNKNOWN-RESTORE-1016 (owner 2026-10-16 reaffirmed UNKNOWN-EMAILS-OPTION-1014: "pourquoi tu as fait ça ? c'est très grave").
-- Migration 0098 (CATCHALL-BOUNCE-1016, rejected) rewrote the 12 source walk rows stored under
-- 'valid_catch_all_and_unknown' to 'valid_and_catch_all'. These are those exact 12 rows, read off the lead-service backup
-- taken before 0098 ran (pg-backups/lead-service/2026-10-16T030011Z.dump): 2 source units x 6 audiences, every value as
-- it stood. Neither source held a 'valid_and_catch_all' row before 0098, so its 12 rows under that value are the fold (or
-- the walk writing under the forced value since) and are removed. Idempotent: a second run changes nothing.
INSERT INTO source_audience_walks (source_campaign_id, audience_id, accepted_emails, last_empty_at, last_empty_reason)
SELECT v.source_campaign_id, v.audience_id, 'valid_catch_all_and_unknown', v.last_empty_at, v.last_empty_reason
  FROM (VALUES
  ('3de6bdb2-3601-45ac-a89f-4083903a217d', '1470680d-3568-4019-b81f-52385f0a449e', '2026-10-16 03:17:30.662229+00'::timestamptz, 'exhausted'),
  ('3de6bdb2-3601-45ac-a89f-4083903a217d', '4c0e96a5-5914-4a7a-b345-bf04a023bd16', '2026-10-16 03:17:31.646884+00'::timestamptz, 'exhausted'),
  ('3de6bdb2-3601-45ac-a89f-4083903a217d', '879d2911-5aa2-4892-8803-579d655407be', '2026-10-16 03:17:32.314897+00'::timestamptz, 'exhausted'),
  ('3de6bdb2-3601-45ac-a89f-4083903a217d', '9ccdee9a-f2a7-41f5-8842-3a875de2c8b7', '2026-10-16 03:17:32.869689+00'::timestamptz, 'exhausted'),
  ('3de6bdb2-3601-45ac-a89f-4083903a217d', '9e34f3cb-500b-4c51-b664-fc91cd00bc66', '2026-10-15 11:54:21.543972+00'::timestamptz, 'exhausted'),
  ('3de6bdb2-3601-45ac-a89f-4083903a217d', 'a444a5ae-fb00-4fe2-ad69-c2d2257ad24c', '2026-10-16 03:17:33.027801+00'::timestamptz, 'exhausted'),
  ('a41c4e52-7d37-4910-ac50-ff87ab66ae04', '1470680d-3568-4019-b81f-52385f0a449e', '2026-10-15 09:31:11.706782+00'::timestamptz, 'exhausted'),
  ('a41c4e52-7d37-4910-ac50-ff87ab66ae04', '4c0e96a5-5914-4a7a-b345-bf04a023bd16', '2026-10-15 09:31:11.988446+00'::timestamptz, 'exhausted'),
  ('a41c4e52-7d37-4910-ac50-ff87ab66ae04', '879d2911-5aa2-4892-8803-579d655407be', '2026-10-15 09:31:12.158189+00'::timestamptz, 'exhausted'),
  ('a41c4e52-7d37-4910-ac50-ff87ab66ae04', '9ccdee9a-f2a7-41f5-8842-3a875de2c8b7', '2026-10-15 09:31:12.278614+00'::timestamptz, 'exhausted'),
  ('a41c4e52-7d37-4910-ac50-ff87ab66ae04', '9e34f3cb-500b-4c51-b664-fc91cd00bc66', '2026-10-15 09:31:12.40403+00'::timestamptz, 'exhausted'),
  ('a41c4e52-7d37-4910-ac50-ff87ab66ae04', 'a444a5ae-fb00-4fe2-ad69-c2d2257ad24c', '2026-10-15 09:31:11.537619+00'::timestamptz, 'exhausted')
  ) AS v(source_campaign_id, audience_id, last_empty_at, last_empty_reason)
ON CONFLICT (source_campaign_id, audience_id, accepted_emails) DO NOTHING;
--> statement-breakpoint
DELETE FROM source_audience_walks w
 USING (VALUES
  ('3de6bdb2-3601-45ac-a89f-4083903a217d', '1470680d-3568-4019-b81f-52385f0a449e'),
  ('3de6bdb2-3601-45ac-a89f-4083903a217d', '4c0e96a5-5914-4a7a-b345-bf04a023bd16'),
  ('3de6bdb2-3601-45ac-a89f-4083903a217d', '879d2911-5aa2-4892-8803-579d655407be'),
  ('3de6bdb2-3601-45ac-a89f-4083903a217d', '9ccdee9a-f2a7-41f5-8842-3a875de2c8b7'),
  ('3de6bdb2-3601-45ac-a89f-4083903a217d', '9e34f3cb-500b-4c51-b664-fc91cd00bc66'),
  ('3de6bdb2-3601-45ac-a89f-4083903a217d', 'a444a5ae-fb00-4fe2-ad69-c2d2257ad24c'),
  ('a41c4e52-7d37-4910-ac50-ff87ab66ae04', '1470680d-3568-4019-b81f-52385f0a449e'),
  ('a41c4e52-7d37-4910-ac50-ff87ab66ae04', '4c0e96a5-5914-4a7a-b345-bf04a023bd16'),
  ('a41c4e52-7d37-4910-ac50-ff87ab66ae04', '879d2911-5aa2-4892-8803-579d655407be'),
  ('a41c4e52-7d37-4910-ac50-ff87ab66ae04', '9ccdee9a-f2a7-41f5-8842-3a875de2c8b7'),
  ('a41c4e52-7d37-4910-ac50-ff87ab66ae04', '9e34f3cb-500b-4c51-b664-fc91cd00bc66'),
  ('a41c4e52-7d37-4910-ac50-ff87ab66ae04', 'a444a5ae-fb00-4fe2-ad69-c2d2257ad24c')
  ) AS k(source_campaign_id, audience_id)
 WHERE w.source_campaign_id = k.source_campaign_id
   AND w.audience_id = k.audience_id
   AND w.accepted_emails = 'valid_and_catch_all';
