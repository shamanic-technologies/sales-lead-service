-- BLANK-CANDIDATES-1101 (1): a candidate human-service offers with NOTHING the screen could judge (empty teaser: no
-- name, title, headline, company name, industry, size, place or keyword) is never screened, passed or declined: it is a
-- loud failure of the producer. One row per candidate, `seen_count` bumped each time it is offered again; read by the
-- `blank-candidates` box check (Monitoring hub). Monitoring evidence: not moved by a brand transfer.
CREATE TABLE IF NOT EXISTS "blank_candidates" (
  "candidate_id" text PRIMARY KEY NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text,
  "audience_id" text NOT NULL,
  "provider_person_id" text NOT NULL,
  "run_id" text,
  "seen_count" integer DEFAULT 1 NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_blank_candidates_last_seen" ON "blank_candidates" ("last_seen_at");
--> statement-breakpoint
-- BLANK-CANDIDATES-1101 (2): a paid serve handed out again and again without anyone being contacted stops for good
-- after a bounded number of claims (retry-pool.ts `MAX_RETRY_CLAIMS`), with its reason. Terminal, like sender_closed_at.
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "retry_stopped_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "retry_stopped_reason" text;
