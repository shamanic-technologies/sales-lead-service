-- What each audience last answered a source unit's own run, per email policy (CATCHALL-NEVER-SOURCED-1014).
-- A Lead Sourcing unit walks dozens of audiences (Doc Dinners: 40, ~8s each) and its caller leaves after 5 minutes:
-- walked in the same order every run, the dry audiences at the head ate the whole budget and the rest were never
-- asked. The walk now puts an audience that answered nobody (exhausted, no recent posts, not serveable) under this
-- policy AFTER every audience that has not, oldest answer first; a serve clears it (src/lib/source-audience-walk.ts).
-- An ORDER, never a skip: every audience is still walked when time allows. Keyed on campaign/audience ids only.
CREATE TABLE IF NOT EXISTS source_audience_walks (
  source_campaign_id text NOT NULL,
  audience_id text NOT NULL,
  accepted_emails text NOT NULL,
  last_empty_at timestamptz NOT NULL,
  last_empty_reason text NOT NULL,
  PRIMARY KEY (source_campaign_id, audience_id, accepted_emails)
);
