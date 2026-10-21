-- UNIBOX-LAST-MESSAGE-PREVIEW-1021 (owner 2026-10-21): a Unibox row shows the first words of its thread's LAST message (ours or theirs), read off crm-service's thread.
ALTER TABLE "unibox_rows" ADD COLUMN IF NOT EXISTS "last_message" jsonb;
--> statement-breakpoint
ALTER TABLE "unibox_rows" ADD COLUMN IF NOT EXISTS "last_message_reason" text;
--> statement-breakpoint
ALTER TABLE "unibox_rows" ADD COLUMN IF NOT EXISTS "last_message_checked_at" timestamp with time zone;
