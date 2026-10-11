-- A thread handed to a HUMAN is never claimed by an automated responder again (owner 2026-10-11,
-- Shockwavecenters: a responder switched on answered every past positive reply, including threads
-- the client had been asked to answer and one staff had promised to follow up).
--
-- followup_handed_at     — when the thread became a person's. Set once, never cleared: unlike a
--                          stop, a later `scheduled` does NOT re-enter the row (src/lib/followup-queue.ts).
-- followup_handed_reason — who it went to / why, as stated (or `owed_before_responder_started`).
ALTER TABLE leads_campaigns ADD COLUMN IF NOT EXISTS followup_handed_at timestamptz;
ALTER TABLE leads_campaigns ADD COLUMN IF NOT EXISTS followup_handed_reason text;

-- Backfill, positive evidence only: rows instantly-service's escalation already stopped with its
-- hand-over wording (lib/escalate-reply, lib/escalate-off-topic-reply). Those threads were handed to
-- a person; their stop was not a tombstone, so a fresh reply would have re-entered them.
UPDATE leads_campaigns
   SET followup_handed_at = COALESCE(followup_handed_at, updated_at),
       followup_handed_reason = COALESCE(followup_handed_reason, followup_stopped_reason),
       followup_due_at = NULL,
       followup_claimed_at = NULL
 WHERE followup_handed_at IS NULL
   AND (
     followup_stopped_reason LIKE 'Handed to %: the automated responder could not answer this reply.'
     OR followup_stopped_reason LIKE '%; handed to a person, the automated responder does not answer it'
     OR followup_stopped_reason LIKE 'The automated responder could not answer: %'
   );

-- The earliest automated responder known to drain each HELD campaign's queue (src/lib/followup-queue.ts).
-- A debt that arose BEFORE it started was never a responder's: the reply was a human's to answer
-- (forwarded, celebrated, or the client asked), so switching a responder on must not answer that
-- backlog. Several responders can drain one held campaign (meeting booker + instant call), so the
-- EARLIEST start wins: a later sibling never hands over its elder's debts. Filled at claim time from
-- campaign-service's campaign row (created_at of the acting campaign), never guessed.
CREATE TABLE IF NOT EXISTS followup_responders (
  held_campaign_id text PRIMARY KEY,
  first_responder_campaign_id text NOT NULL,
  first_responder_started_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
