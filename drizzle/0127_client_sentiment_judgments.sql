-- CLIENT-SENTIMENT-1027: one Client Sentiment verdict per message a CLIENT of a brand writes the brand (crm-service's
-- people fact feed, `crm_facts` type `message_in`, every channel), judged once by Jev and frozen with the model release.
-- Keyed on the fact only (like crm_act_judgments): org, brand, contact point and instant are the fact's, read by join,
-- so a brand transfer moving `crm_facts` moves the verdicts with it.
CREATE TABLE IF NOT EXISTS client_sentiment_judgments (
  fact_id text PRIMARY KEY,
  sentiment text NOT NULL CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  confidence double precision NOT NULL,
  model text NOT NULL,
  judged_at timestamptz NOT NULL DEFAULT now()
);
