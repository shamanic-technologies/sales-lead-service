-- lead_requested trigger events campaign-service has not recorded yet (src/lib/lead-requested-events.ts).
CREATE TABLE IF NOT EXISTS trigger_event_outbox (
  idempotency_key text PRIMARY KEY,
  org_id text NOT NULL,
  event jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  refused_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trigger_event_outbox_due ON trigger_event_outbox (next_attempt_at);
