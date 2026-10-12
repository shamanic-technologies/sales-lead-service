-- LEADS-ONLY-FUNNEL-CAMPAIGN (2026-10-12): a source unit's own run stores each lead it finds under the source
-- campaign (status_reason = 'source_found'); an outreach campaign fed by it takes the lead from that stock, once.
-- source_handed_at / source_handed_to_campaign_id = the hand-off claim (src/lib/source-stock.ts). NULL on every
-- other row; nothing backfilled.
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "source_handed_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "source_handed_to_campaign_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_lc_source_found" ON "leads_campaigns" ("campaign_id", "served_at") WHERE "status_reason" = 'source_found';
