-- Which emails each pipe fed by a source unit ACCEPTS, as that pipe last stated it (CATCHALL-NEVER-SOURCED-1014).
-- An outreach campaign that serves a source's stock states its email policy (`acceptedEmails`) on every ask; the
-- source unit's own run reads it here and asks human-service for the widest policy its pipes accept, so a funnel
-- whose cold email accepts catch-all gets catch-all people found (src/lib/source-email-demand.ts).
-- Keyed on campaign ids only (globally unique): not org-keyed, untouched by a brand transfer.
CREATE TABLE IF NOT EXISTS source_email_demands (
  source_campaign_id text NOT NULL,
  outreach_campaign_id text NOT NULL,
  accepted_emails text NOT NULL,
  asked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_campaign_id, outreach_campaign_id)
);
