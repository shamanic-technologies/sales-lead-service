-- PERSON-RELATIONS-1017 (owner 2026-10-17): a Unibox row is a RELATION (a human x organization), never the whole human.
-- 1. Each crm fact names the CONTACT POINT it happened on (crm-service's `presenceStableKey`, `<source>:<stable id>`),
--    so a relation's thread is the facts of ITS points only. Facts copied before crm served it: `source:sourceContactId`.
ALTER TABLE "crm_facts" ADD COLUMN IF NOT EXISTS "contact_point" text;
--> statement-breakpoint
ALTER TABLE "crm_registry_facts" ADD COLUMN IF NOT EXISTS "contact_point" text;
--> statement-breakpoint
UPDATE "crm_facts" SET "contact_point" = COALESCE(NULLIF("raw"->>'contactPoint', ''), "source" || ':' || "source_contact_id")
WHERE "contact_point" IS NULL AND (NULLIF("raw"->>'contactPoint', '') IS NOT NULL OR COALESCE("source_contact_id", '') <> '');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_crm_facts_brand_contact_point" ON "crm_facts" ("org_id", "brand_id", "contact_point");
--> statement-breakpoint
-- 2. A subject (one Unibox row) = the human at ONE company: the crm relations folded into it, and their points.
ALTER TABLE "relationship_subjects" ADD COLUMN IF NOT EXISTS "relation_keys" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "relationship_subjects" ADD COLUMN IF NOT EXISTS "contact_points" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
-- The human holds another relation at the brand (personal or another company): a judgment read off the whole human
-- thread is not this relation's, it is asked again on the relation's own thread.
ALTER TABLE "relationship_subjects" ADD COLUMN IF NOT EXISTS "shares_human" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "relationship_subjects" DROP CONSTRAINT IF EXISTS "relationship_subjects_pkey";
--> statement-breakpoint
ALTER TABLE "relationship_subjects" ADD PRIMARY KEY ("org_id", "brand_id", "human_id", "company_key");
--> statement-breakpoint
-- 3. Which thread a judgment read: 'human' (every judgment before relations) or 'relation'.
ALTER TABLE "relationship_judgments" ADD COLUMN IF NOT EXISTS "thread_scope" text NOT NULL DEFAULT 'human';
--> statement-breakpoint
ALTER TABLE "relationship_intent_judgments" ADD COLUMN IF NOT EXISTS "company_key" text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE "relationship_intent_judgments" ADD COLUMN IF NOT EXISTS "thread_scope" text NOT NULL DEFAULT 'human';
--> statement-breakpoint
UPDATE "relationship_intent_judgments" i SET "company_key" = s."company_key"
FROM "relationship_subjects" s
WHERE s."org_id" = i."org_id" AND s."brand_id" = i."brand_id" AND s."human_id" = i."human_id" AND i."company_key" = '' AND s."company_key" <> '';
--> statement-breakpoint
ALTER TABLE "relationship_intent_judgments" DROP CONSTRAINT IF EXISTS "relationship_intent_judgments_pkey";
--> statement-breakpoint
ALTER TABLE "relationship_intent_judgments" ADD PRIMARY KEY ("org_id", "brand_id", "human_id", "company_key");
--> statement-breakpoint
-- 4. Unibox rows at the relation grain.
ALTER TABLE "unibox_rows" ADD COLUMN IF NOT EXISTS "relation_keys" text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE "unibox_rows" DROP CONSTRAINT IF EXISTS "unibox_rows_pkey";
--> statement-breakpoint
ALTER TABLE "unibox_rows" ADD PRIMARY KEY ("org_id", "brand_id", "human_id", "company_key");
