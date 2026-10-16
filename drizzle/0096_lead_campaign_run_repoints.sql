-- Which workflow actually EMAILED a person (WORKFLOW-SEND-HISTORY-1016, src/lib/brand-journeys.ts `emailSends`).
-- A `leads_campaigns` row names the workflow that SERVED the person (`workflow_slug`), but the row can be re-pointed at
-- another run before anything is sent: a retry-pool claim (`claimCandidate`) or a named-lead serve hands the same paid
-- person to the asking run, which may run another workflow of the campaign. That run sends, and its workflow was
-- recorded nowhere here (2,201 of 4,023 retried-then-sent rows in prod were sent by a workflow other than the row's).
-- One row per re-point: the run now holding the row, its workflow, from when. A send is credited to the latest
-- re-point at or before it, else to the row's own serve.
CREATE TABLE IF NOT EXISTS lead_campaign_run_repoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_campaign_id uuid NOT NULL REFERENCES leads_campaigns(id) ON DELETE CASCADE,
  run_id text,
  workflow_slug text,
  repointed_at timestamptz NOT NULL,
  cause text NOT NULL CHECK (cause IN ('retry_claim', 'named_serve')),
  recorded_by text NOT NULL DEFAULT 'live' CHECK (recorded_by IN ('live', 'backfill')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lcrr_row_at ON lead_campaign_run_repoints (lead_campaign_id, repointed_at DESC);
