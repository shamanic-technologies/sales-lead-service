-- 0038: which people in the customer's own CRM are leads we emailed.
--
-- A customer runs their own CRM and we mirror it (crm-service). Their CRM already knows things
-- about people we contacted that we do not — a deal closed on a call, a meeting that was attended.
-- Nothing paired the two sides, so none of it reached us.
--
-- Three tables, one per kind of fact, because they have different authors and different lifetimes:
--
--   crm_pairing_matches   — the identity waterfall's answer for one CRM contact, FROZEN. The
--                           matcher is the one that already attributes inbound conversion events;
--                           it is reused, not reimplemented. Frozen (never recomputed on read) so
--                           the same pairing resolves the same way twice and the customer's table
--                           does not change under them between page loads.
--   crm_pairing_judgments — a similarity judgment from the fleet's typed-judgment vendor, asked
--                           only where the deterministic signals could not decide, asked once, and
--                           stored WITH THE MODEL RELEASE that produced it. An alias moves to a new
--                           model without notice, so a frozen answer named by an alias is not
--                           auditable.
--   crm_pairing_rulings   — a HUMAN's statement, which outranks both. Keyed on the PAIR rather
--                           than on a matcher run, which is what stops a re-run resurrecting
--                           something a person already rejected.
--
-- NOTHING IS DELETED: a ruling is withdrawn by marking it, every read filters `withdrawn_at IS
-- NULL`, and restating clears the mark — the same posture step statements already take.
--
-- `crm_contact_id` is crm-service's own contacts uuid, held as text: another service owns that
-- row, so there is nothing here to reference.
--
-- The expression indexes at the bottom are what the reused waterfall needs to run a few thousand
-- times in one request instead of sequentially scanning a brand's leads per contact. They change
-- no behaviour and the existing conversion-attribution path gets them for free.
--
-- Idempotent: a partially-applied state is a no-op.

CREATE TABLE IF NOT EXISTS "crm_pairing_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "crm_contact_id" text NOT NULL,
  "matched_lead_id" uuid,
  "match_method" text,
  "match_confidence" text NOT NULL,
  "candidate_count" integer DEFAULT 0 NOT NULL,
  "matched_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "crm_pairing_judgments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "crm_contact_id" text NOT NULL,
  "lead_id" uuid NOT NULL,
  "same_person_probability" double precision NOT NULL,
  "judgment_model" text NOT NULL,
  "judged_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "crm_pairing_rulings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "crm_contact_id" text NOT NULL,
  "lead_id" uuid NOT NULL,
  "ruling" text NOT NULL,
  "note" text,
  "stated_by_user_id" text,
  "withdrawn_at" timestamp with time zone,
  "withdrawn_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "crm_pairing_matches"
    ADD CONSTRAINT "crm_pairing_matches_matched_lead_id_leads_id_fk"
    FOREIGN KEY ("matched_lead_id") REFERENCES "leads"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "crm_pairing_judgments"
    ADD CONSTRAINT "crm_pairing_judgments_lead_id_leads_id_fk"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "crm_pairing_rulings"
    ADD CONSTRAINT "crm_pairing_rulings_lead_id_leads_id_fk"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One frozen match per (brand, their contact) — the freeze IS the stability guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cpm_brand_contact"
  ON "crm_pairing_matches" ("brand_id", "crm_contact_id");
-- "how many of our leads their CRM has never heard of" reads this way round.
CREATE INDEX IF NOT EXISTS "idx_cpm_brand_lead"
  ON "crm_pairing_matches" ("brand_id", "matched_lead_id");

-- A new model release adds a row rather than replacing one: what an older release answered stays
-- readable, and the pairing keeps whichever judgment it was frozen with.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cpj_brand_contact_lead_model"
  ON "crm_pairing_judgments" ("brand_id", "crm_contact_id", "lead_id", "judgment_model");
CREATE INDEX IF NOT EXISTS "idx_cpj_brand_contact"
  ON "crm_pairing_judgments" ("brand_id", "crm_contact_id");

-- One live statement per pair; restating is an upsert onto this row, which also clears withdrawal.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cpr_brand_contact_lead"
  ON "crm_pairing_rulings" ("brand_id", "crm_contact_id", "lead_id");
CREATE INDEX IF NOT EXISTS "idx_cpr_brand_live"
  ON "crm_pairing_rulings" ("brand_id")
  WHERE "withdrawn_at" IS NULL;

-- The waterfall's own tier predicates. Without these each tier sequentially scans the brand's
-- leads, and a summary over a few thousand CRM contacts runs a few thousand of those.
CREATE INDEX IF NOT EXISTS "idx_leads_lower_last_name"
  ON "leads" (lower("last_name"));
CREATE INDEX IF NOT EXISTS "idx_leads_lower_first_last_name"
  ON "leads" (lower("first_name"), lower("last_name"));
CREATE INDEX IF NOT EXISTS "idx_lcm_email_lower_value"
  ON "lead_contact_methods" (lower("value"))
  WHERE "channel" = 'email';
CREATE INDEX IF NOT EXISTS "idx_lcm_phone_digits"
  ON "lead_contact_methods" (regexp_replace("value", '\D', '', 'g'))
  WHERE "channel" = 'phone';
CREATE INDEX IF NOT EXISTS "idx_org_lower_primary_domain"
  ON "organizations" (lower("primary_domain"));
