-- WRITTEN-BY-1019-SENDER: a follow-up ledger row names the workflow VERSION of the run that wrote it
-- (x-workflow-slug of the claiming / acting run), so "which workflow version sent this message" is a
-- recorded fact, never re-derived. NULL = recorded before this column, or a run that stated none.
ALTER TABLE "followup_actions" ADD COLUMN IF NOT EXISTS "workflow_slug" text;
CREATE INDEX IF NOT EXISTS "idx_fa_lead_org" ON "followup_actions" ("lead_id", "org_id");
