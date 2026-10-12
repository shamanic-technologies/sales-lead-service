-- 0069: a person a SENDER refused for a reason about its CHANNEL is released to the brand's other pipes
-- (owner 2026-10-12). A WhatsApp send refusing `no_phone_known` / `not_on_whatsapp` says nothing about the person:
-- the email pipe can still reach them. The refusing campaign's row records it (POST
-- /orgs/campaigns/{campaignId}/leads/channel-refusals, src/lib/released-pool.ts): it leaves that campaign's retry
-- pool for good (send_refused_* with no end), and another campaign of the brand whose channel CAN reach the person
-- takes them, once (released_taken_at / released_to_campaign_id = the hand-off claim).
-- Idempotent; NULL on every existing row, nothing backfilled.
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "channel_released_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "channel_released_code" text;
--> statement-breakpoint
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "released_taken_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "released_to_campaign_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lc_channel_released" ON "leads_campaigns" ("org_id", "channel_released_at") WHERE "channel_released_at" IS NOT NULL AND "released_taken_at" IS NULL;
