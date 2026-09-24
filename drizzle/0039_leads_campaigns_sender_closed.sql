-- 0039: the SENDER said it is done with this person in this campaign, without sending.
--
-- The paid-pool retry (src/lib/retry-pool.ts) re-serves people this campaign bought and never
-- emailed. The sender idempotently claims each (campaign, email) the first time it is handed a
-- person, and it can finish that claim WITHOUT sending anything (the sequence ended, was stopped,
-- or was refused). Every later hand-off of that person to the same campaign is answered as a
-- duplicate and sends nothing, so re-serving them only burns the run slot that would have bought
-- somebody new — measured on campaign 3922c8e1: one person handed out 104 times.
--
-- The sender now STATES that it is finished on its status read. This column records that
-- statement once, so the row leaves the pool for good and is never re-queried. It is NOT
-- `sent_at`: that column means an email went out, and the lead history reads it as one.
--
-- Idempotent: a partially-applied state is a no-op.

ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "sender_closed_at" timestamp with time zone;
