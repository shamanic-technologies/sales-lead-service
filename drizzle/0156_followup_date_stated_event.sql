-- FOLLOWUP-HOLD-OVERWRITTEN-1126: which trigger occurrence last stated a person's one follow-up date (NULL = not an
-- occurrence: a writer, a worker, a send). A redelivered occurrence first named before a newer statement of the date
-- never replaces that statement (followup-queue.ts statePersonDateSql). Additive, idempotent.
ALTER TABLE "lead_followup_dates" ADD COLUMN IF NOT EXISTS "stated_event_id" text;
