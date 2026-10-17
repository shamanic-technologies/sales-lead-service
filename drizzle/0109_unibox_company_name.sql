-- Owner 2026-10-17: a Unibox row reads "Adam Nasri @ Cifacom" (+ the company logo by domain).
ALTER TABLE "unibox_rows" ADD COLUMN IF NOT EXISTS "company_name" text;
--> statement-breakpoint
ALTER TABLE "unibox_rows" ADD COLUMN IF NOT EXISTS "company_domain" text;
