-- COST-ACCOUNTING-1023-P1: every run of ours that spends states, at runs-service, the outcome occurrences it
-- produced and consumed (POST /v1/runs/{runId}/outcomes). The declaration never blocks or fails the serve: one
-- that runs-service did not take (down, 5xx, not deployed) waits here and the background thread redelivers it
-- with backoff; a refusal (400/404/409) is kept with refused_at + the answer, never dropped. Transient queue:
-- not moved by a brand transfer (like trigger_event_outbox).
CREATE TABLE IF NOT EXISTS "run_outcome_outbox" (
  "idempotency_key" text PRIMARY KEY,
  "org_id" text NOT NULL,
  "run_id" uuid NOT NULL,
  "declaration" jsonb NOT NULL,
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "next_attempt_at" timestamptz NOT NULL DEFAULT now(),
  "refused_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_run_outcome_outbox_due" ON "run_outcome_outbox" ("next_attempt_at") WHERE "refused_at" IS NULL;
