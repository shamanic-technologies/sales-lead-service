-- Apollo 100% field coverage: extend enrichments cache with full Apollo person fields
ALTER TABLE "enrichments" ADD COLUMN IF NOT EXISTS "name" text;--> statement-breakpoint
ALTER TABLE "enrichments" ADD COLUMN IF NOT EXISTS "personal_emails" jsonb;--> statement-breakpoint
ALTER TABLE "enrichments" ADD COLUMN IF NOT EXISTS "mobile_phone" text;--> statement-breakpoint
ALTER TABLE "enrichments" ADD COLUMN IF NOT EXISTS "phone_numbers" jsonb;--> statement-breakpoint
ALTER TABLE "enrichments" ADD COLUMN IF NOT EXISTS "organization_id" text;--> statement-breakpoint
ALTER TABLE "enrichments" ADD COLUMN IF NOT EXISTS "organization_raw_address" text;
