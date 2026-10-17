-- UNIBOX-SIX-TAGS-1017 (2026-10-17): the Unibox read model. One row per lead of the brand (a person crm-service tags
-- professional to the brand, at their company) with the six tag dimensions (Type, Lifecycle, Interest, Conversation
-- status, Contactability, Fit), the steps reached and each side's last word. Rebuilt by the relationship sweep.
CREATE TABLE IF NOT EXISTS "unibox_rows" (
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "human_id" uuid NOT NULL,
  "company_key" text NOT NULL DEFAULT '',
  "name" text,
  "emails" text[] NOT NULL DEFAULT '{}',
  "phones" text[] NOT NULL DEFAULT '{}',
  "lead_ids" uuid[] NOT NULL DEFAULT '{}',
  "types" text[] NOT NULL DEFAULT '{}',
  "lifecycle_key" text,
  "lifecycle_rank" integer,
  "steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "interest" text NOT NULL,
  "conversation" text NOT NULL,
  "contactability" text NOT NULL,
  "fit" text NOT NULL,
  "fit_note" text,
  "last_theirs_at" timestamp with time zone,
  "last_ours_at" timestamp with time zone,
  "last_activity_at" timestamp with time zone NOT NULL,
  "connection_tags" text[] NOT NULL DEFAULT '{}',
  "search_text" text NOT NULL DEFAULT '',
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "brand_id", "human_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_unibox_rows_activity" ON "unibox_rows" ("org_id", "brand_id", "last_activity_at" DESC, "human_id" DESC);
