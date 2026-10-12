-- STILL-FITS-1012 (2026-10-12): a lead a source found is handed from its stock only if it still fits the audience it
-- was found for, asked of the audience's owner (human-service) at handover. One that no longer fits is SET ASIDE:
-- source_set_aside_at + the owner's reason in its own words. Never handed again (src/lib/source-stock.ts). NULL on
-- every other row; nothing backfilled.
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "source_set_aside_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "source_set_aside_reason" text;
