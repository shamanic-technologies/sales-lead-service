-- 0089: a message went out to this person on the campaign's NON-EMAIL channel (WhatsApp today), as the
-- service that SENT it states (crm-service's send record carrying this campaign id).
--
-- The paid-pool retry (src/lib/retry-pool.ts) asked email-gateway alone whether a served person was contacted.
-- A WhatsApp send never reaches email-gateway, so every WhatsApped person read "never contacted" and was handed
-- back as soon as the claim lease lapsed (WA-RESERVE-LOOP-1014, campaign 4af21454 "Valued", 2026-10-12/13:
-- 8 people written once each, re-served 16-18 times each, 147 drafts for 8 messages, almost no new people).
--
-- Kept apart from `sent_at`, which the lead history reads as the email hand-off: this is the sender's own
-- statement for another channel. Written once, the row leaves the pool for good and is never re-asked.
-- `channel_send_id` = the sender's own id for that send (crm-service `sendId`), for tracing.
--
-- Idempotent: a partially-applied state is a no-op.

ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "channel_sent_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "channel_send_id" text;
