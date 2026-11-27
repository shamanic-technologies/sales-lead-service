-- A person the brand's org names by MESSAGING HANDLE only (LEAD-REPLY-CHANNEL-1127-LS): a Telegram / LinkedIn writer
-- known by neither an email nor a phone, named `msg:<network>:<id>` (crm-service's string). The statement
-- (brand_person_statements, 0079 + 0093) records the handle with `email` and `phone` NULL, plus the human-service
-- human when the caller resolved it. Email and phone rows unchanged. src/lib/named-person.ts.
ALTER TABLE brand_person_statements ADD COLUMN IF NOT EXISTS handle text;
--> statement-breakpoint
ALTER TABLE brand_person_statements ADD COLUMN IF NOT EXISTS human_id uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_bps_handle_key
  ON brand_person_statements (org_id, brand_id, handle, source, source_ref) WHERE email IS NULL AND phone IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bps_brand_handle ON brand_person_statements (org_id, brand_id, handle) WHERE handle IS NOT NULL;
