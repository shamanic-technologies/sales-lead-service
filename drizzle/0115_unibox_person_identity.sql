-- UNIBOX-PERSON-NAME-1021 (owner 2026-10-21): a Unibox row names WHO it is ("Andreas Oberleitner, Head of RA @ Platomics"), never an address.
ALTER TABLE "unibox_rows" ADD COLUMN IF NOT EXISTS "first_name" text;
--> statement-breakpoint
ALTER TABLE "unibox_rows" ADD COLUMN IF NOT EXISTS "last_name" text;
--> statement-breakpoint
ALTER TABLE "unibox_rows" ADD COLUMN IF NOT EXISTS "title" text;
