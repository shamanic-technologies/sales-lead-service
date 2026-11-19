-- REPLY-NO-BALANCE-1118: a person waiting on our answer for more than an hour turns dashboard v2 Monitoring red.
-- One row per (UTC day, org, brand) the watch sweep (src/lib/awaiting-answer-watch.ts) saw: how many people waited on
-- us past the hour at the day's latest sample, the day's worst sample, and who (the latest sample's list). Written only
-- by the sweep; the daily series the Monitoring chart draws.
CREATE TABLE IF NOT EXISTS awaiting_answer_watch_days (
  day date NOT NULL,
  org_id text NOT NULL,
  brand_id text NOT NULL,
  waiting_over_hour integer NOT NULL,
  max_waiting_over_hour integer NOT NULL,
  people jsonb NOT NULL,
  sampled_at timestamptz NOT NULL,
  PRIMARY KEY (day, org_id, brand_id)
);
CREATE TABLE IF NOT EXISTS awaiting_answer_watch_sweeps (
  id bigserial PRIMARY KEY,
  finished_at timestamptz NOT NULL DEFAULT now(),
  brands integer NOT NULL,
  failed_brands integer NOT NULL
);
