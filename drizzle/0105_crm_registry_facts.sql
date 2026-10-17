-- CRM-REGISTRY-FACTS-1017 (2026-10-17): crm-service's people fact feed now also states who a person IS to the brand
-- (`connection_tag`, `organization_link`). They are copied here, beside `crm_facts`, so no reader of `crm_facts`
-- (acts toward us, direct conversation, known to the CRM) ever reads one as something the person did.
CREATE TABLE IF NOT EXISTS "crm_registry_facts" (
  "fact_id" text PRIMARY KEY NOT NULL,
  "seq" bigint NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "person_key" text NOT NULL,
  "source_contact_id" text,
  "crm_contact_id" text,
  "full_name" text,
  "emails" text[] NOT NULL,
  "phones" text[] NOT NULL,
  "type" text NOT NULL,
  "occurred_at" timestamp with time zone,
  "date_basis" text NOT NULL,
  "source" text NOT NULL,
  "source_ref" text NOT NULL,
  "payload" jsonb NOT NULL,
  "withdrawn_of" text,
  "raw" jsonb NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_crm_registry_facts_seq" ON "crm_registry_facts" ("seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_registry_facts_brand_type" ON "crm_registry_facts" ("org_id", "brand_id", "type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_registry_facts_withdrawn_of" ON "crm_registry_facts" ("withdrawn_of");
