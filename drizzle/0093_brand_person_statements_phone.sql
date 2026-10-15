-- A person the brand's org names by PHONE only (REPLY-PHONE-ONLY-1015, 2026-10-15): most people who write
-- to a brand on WhatsApp carry no email, only their E.164 phone and the name WhatsApp shows. The statement
-- (brand_person_statements, migration 0079) records the phone; `email` is NULL for such a person. A person
-- stated with an email keeps the email row, byte-identical. src/lib/named-person.ts.
ALTER TABLE brand_person_statements ADD COLUMN IF NOT EXISTS phone text;
--> statement-breakpoint
ALTER TABLE brand_person_statements ALTER COLUMN email DROP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_bps_phone_key
  ON brand_person_statements (org_id, brand_id, phone, source, source_ref) WHERE email IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bps_brand_phone ON brand_person_statements (org_id, brand_id, phone) WHERE phone IS NOT NULL;
