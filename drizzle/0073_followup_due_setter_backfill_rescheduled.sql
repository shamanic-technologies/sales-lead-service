-- 0073: 0071's ownership backfill found nothing to mark: the cold WhatsApp outreach 4af21454 re-scheduled its
-- own follow-ups at 2026-10-12 16:48-16:51 UTC, minutes before 0071 deployed, so every due date had moved and
-- 0071's exact-due guard (correctly) skipped them. Same positive evidence, re-read: Windmill `schedule_followup`
-- jobs of that campaign's own runs (e.g. 01a13104-740a-e69c-126a-14cb04ab2fef -> row b8649093, due
-- 2026-10-15T16:48:57.139Z), each job's dueAt equal to the row's due date to the millisecond. Since 0071 every
-- schedule this campaign writes records itself as the setter, so a row it re-schedules after this needs nothing.
-- Guarded on the due date (a row rewritten since is left as its writer stated it). Due dates untouched.
UPDATE leads_campaigns lc
   SET followup_due_set_by_campaign_id = lc.campaign_id
  FROM (VALUES
    ('b8649093-8042-414b-8d65-4bacdc9d43d4'::uuid, '2026-10-15T16:48:57.139Z'::timestamptz),
    ('5f29279e-97b9-406b-b961-da4d5c9c7e84'::uuid, '2026-10-15T16:49:24.845Z'::timestamptz),
    ('26e267d9-2f72-4ed7-a3ec-fc8b0cc0e31e'::uuid, '2026-10-15T16:49:47.802Z'::timestamptz),
    ('aa5b2f2d-b0a0-4e6e-b7dd-7de3f7694e4f'::uuid, '2026-10-15T16:50:18.377Z'::timestamptz),
    ('71d0b9ee-2a65-4f3f-9a81-e287c84e5b06'::uuid, '2026-10-15T16:50:43.492Z'::timestamptz),
    ('d755a0fd-640d-4864-99a7-d07894acdf7e'::uuid, '2026-10-15T16:51:06.778Z'::timestamptz),
    ('e8b46a80-4d02-4a65-9b02-1f2122e5f292'::uuid, '2026-10-15T16:51:27.597Z'::timestamptz),
    ('6ff594c9-dc37-4b59-852b-6b55ed2152cc'::uuid, '2026-10-15T16:51:49.279Z'::timestamptz)
  ) AS evidence(id, due)
 WHERE lc.id = evidence.id
   AND lc.campaign_id = '4af21454-ae93-4d62-8528-cc95081145ac'
   AND lc.followup_due_at = evidence.due
   AND lc.followup_due_set_by_campaign_id IS NULL;
