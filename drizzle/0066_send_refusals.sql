-- 0066: the SENDER refused to send to this person, and said until when.
--
-- The paid-pool retry (src/lib/retry-pool.ts) re-serves people this campaign bought and never
-- emailed. A person the sender REFUSES to email (they were emailed for this brand inside the
-- sender's re-contact window, or they opted out) reads exactly like a stranded one: not
-- contacted, not queued. So the pool handed the same refused people back on every run, every
-- run failed on them, and the campaign froze (RECONTACT-LOOP-1011, Perky, 2026-10-11: 7 people,
-- ~5 attempts each, 14 consecutive failed runs).
--
-- These columns record the sender's own statement of the refusal: its code verbatim and when it
-- lapses (NULL = never, e.g. an opt-out). While it stands, the row is out of the pool; once it
-- lapses the sender is asked again. Nothing here derives a refusal: only the sender writes it,
-- through its status read.
--
-- Idempotent: a partially-applied state is a no-op.

ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "send_refused_at" timestamp with time zone;
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "send_refusal_code" text;
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "send_refused_until" timestamp with time zone;
