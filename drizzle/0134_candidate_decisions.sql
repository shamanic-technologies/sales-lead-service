-- FACTORY-P3 next outcomes (lead_identified): every candidate DECISION of a candidates serve (screen, must-pass,
-- reveal or decline) with each call in the stored script's words, on either path (`service` = our own code on its own
-- `candidate-decision` run, `script` = the stored script while switched). Bronze, append-only. Read only by
-- GET /internal/candidate-decisions/recorded (workflow-service's case recorder).
CREATE TABLE IF NOT EXISTS "candidate_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "seq" bigserial NOT NULL,
  "org_id" text NOT NULL,
  "serve_run_id" text,
  "run_id" text,
  "audience_id" text NOT NULL,
  "candidate_id" text NOT NULL,
  "path" text NOT NULL,
  "has_target" boolean NOT NULL,
  "calls" jsonb NOT NULL,
  "decision" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "candidate_decisions_path_check" CHECK ("path" IN ('service', 'script'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_candidate_decisions_seq" ON "candidate_decisions" ("seq");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_candidate_decisions_created" ON "candidate_decisions" ("created_at");
