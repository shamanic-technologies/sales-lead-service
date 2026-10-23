-- COST-ACCOUNTING-1023-LEAD-FIX: one outcome-recording run per (org, brand, UTC day, OUTCOME KEY). runs-service
-- attributes a run's consumptions to the outcomes that run produced (split by quantity), so a run producing
-- meeting_booked + meeting_attended + paid_client made `meeting_attended` consume itself (a cost loop).
-- Repair: every declaration sitting on a run that produced more than one key is released, so the sweep declares it
-- again on a per-outcome run (runs-service's ledger keeps the old occurrences: it offers no retraction); those
-- multi-key runs leave outcome_recording_runs. A run that produced a single key keeps its row under that key.
ALTER TABLE "outcome_recording_runs" ADD COLUMN IF NOT EXISTS "outcome_key" text;
--> statement-breakpoint
DELETE FROM "outcome_fact_declarations"
WHERE "run_id" IN (
  SELECT "run_id" FROM "outcome_fact_declarations" GROUP BY "run_id" HAVING count(DISTINCT "outcome_key") > 1
);
--> statement-breakpoint
UPDATE "outcome_recording_runs" r
SET "outcome_key" = (SELECT min(d."outcome_key") FROM "outcome_fact_declarations" d WHERE d."run_id" = r."run_id")
WHERE r."outcome_key" IS NULL;
--> statement-breakpoint
DELETE FROM "outcome_recording_runs" WHERE "outcome_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "outcome_recording_runs" ALTER COLUMN "outcome_key" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
    WHERE c.relname = 'outcome_recording_runs' AND i.indisprimary AND i.indnatts = 4
  ) THEN
    ALTER TABLE "outcome_recording_runs" DROP CONSTRAINT IF EXISTS "outcome_recording_runs_pkey";
    ALTER TABLE "outcome_recording_runs" ADD PRIMARY KEY ("org_id", "brand_id", "day", "outcome_key");
  END IF;
END $$;
