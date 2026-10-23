-- COST-ACCOUNTING-1023-P1 (second pass): every meeting booked, meeting attended and sale our outreach caused
-- (conversion_events.caused_by_outreach = true) is an outcome occurrence of the person (meeting_booked,
-- meeting_attended, paid_client) declared on a recording run of ours at runs-service. One recording run per
-- (org, brand, UTC day), no cost of its own; one declaration per (org, brand, lead, outcome), ever.
CREATE TABLE IF NOT EXISTS "outcome_recording_runs" (
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "day" date NOT NULL,
  "run_id" uuid NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "brand_id", "day")
);
CREATE TABLE IF NOT EXISTS "outcome_fact_declarations" (
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "lead_id" uuid NOT NULL,
  "outcome_key" text NOT NULL,
  "conversion_event_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "consumed_outcome_key" text NOT NULL,
  "consumed_basis" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("org_id", "brand_id", "lead_id", "outcome_key")
);
