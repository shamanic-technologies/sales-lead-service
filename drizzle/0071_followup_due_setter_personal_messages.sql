-- 0071, two additions (owner 2026-10-12, WA-RESPONDER-1012: the AI responder answers WhatsApp like email).
--
-- (A) WHO a follow-up due date is for (src/lib/followup-queue.ts). Two workers share one queue row: an
-- outreach that schedules its OWN follow-up on its own row (the cold WhatsApp outreach: one follow-up 3 days
-- out), and a responder that claims its predecessor's queue. The writer of the due date says whose debt it is:
--   followup_due_set_by_campaign_id = campaign_id  -> the holder's own debt: only the holder claims it;
--   = another campaign                             -> that campaign's ladder on a predecessor's person: anyone
--                                                     BUT the holder claims it;
--   NULL                                           -> an observer said "due" (instantly-service on a reply,
--                                                     campaign-service on a trigger): anyone claims it.
-- NULL on every existing row = today's behaviour, byte-identical.
ALTER TABLE leads_campaigns ADD COLUMN IF NOT EXISTS followup_due_set_by_campaign_id text;
--> statement-breakpoint
-- Backfill, positive evidence only: the 7 rows whose CURRENT due date the cold WhatsApp outreach campaign
-- 4af21454 wrote itself, from its own runs (Windmill `schedule_followup` jobs of 2026-10-12 15:44-15:49 UTC,
-- campaignId = 4af21454, each job's `dueAt` equal to the row's due date to the millisecond; e.g. job
-- 01a130c8-ff82-ff46-a31f-6ce1e3f1e066 -> row b8649093, due 2026-10-15T15:44:01.037Z). The only campaign
-- that ever scheduled its own row (every other successful `schedule_followup` job on the instance is listed
-- here). Guarded on the due date: a row whose due date someone rewrote since is left NULL. Due dates untouched.
UPDATE leads_campaigns lc
   SET followup_due_set_by_campaign_id = lc.campaign_id
  FROM (VALUES
    ('b8649093-8042-414b-8d65-4bacdc9d43d4'::uuid, '2026-10-15T15:44:01.037Z'::timestamptz),
    ('26e267d9-2f72-4ed7-a3ec-fc8b0cc0e31e'::uuid, '2026-10-15T15:46:18.903Z'::timestamptz),
    ('aa5b2f2d-b0a0-4e6e-b7dd-7de3f7694e4f'::uuid, '2026-10-15T15:46:43.343Z'::timestamptz),
    ('71d0b9ee-2a65-4f3f-9a81-e287c84e5b06'::uuid, '2026-10-15T15:47:07.008Z'::timestamptz),
    ('d755a0fd-640d-4864-99a7-d07894acdf7e'::uuid, '2026-10-15T15:48:03.950Z'::timestamptz),
    ('e8b46a80-4d02-4a65-9b02-1f2122e5f292'::uuid, '2026-10-15T15:48:52.912Z'::timestamptz),
    ('6ff594c9-dc37-4b59-852b-6b55ed2152cc'::uuid, '2026-10-15T15:49:41.009Z'::timestamptz)
  ) AS evidence(id, due)
 WHERE lc.id = evidence.id
   AND lc.campaign_id = '4af21454-ae93-4d62-8528-cc95081145ac'
   AND lc.followup_due_at = evidence.due
   AND lc.followup_due_set_by_campaign_id IS NULL;
--> statement-breakpoint
-- (B) What a person's message on a personal channel (crm fact copy, source 'matrix': WhatsApp, LinkedIn...)
-- asks of us, judged ONCE by Jev and frozen (src/lib/personal-messages.ts). "Needs your call" reads it the way
-- it reads the outreach provider's verdict on an email reply.
CREATE TABLE IF NOT EXISTS personal_message_judgments (
  fact_id text PRIMARY KEY,
  org_id text NOT NULL,
  brand_id text NOT NULL,
  lead_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  -- waits_question | waits_interest | waits_other | closing | stop_request | automated
  verdict text NOT NULL,
  confidence double precision NOT NULL,
  model text NOT NULL,
  judged_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_personal_message_judgments_brand ON personal_message_judgments (org_id, brand_id);
