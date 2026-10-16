-- JOURNALISTS-NOT-LEADS-1016 (owner 2026-10-16: "il faut les tagger differemment que lead, mais journalists dans le
-- backend. Ce ne sont pas des leads"). A brand never sells to a journalist: one row per (org, brand, lead) the brand
-- reached through a press pitch only (`press_only`, evidence) or that a person / Jev says is a journalist. `journalist`
-- is the DECIDED answer (person > press-only evidence > judgment); every sales pool, claim and serve refuses a lead
-- whose row says true. Rewritten by src/lib/brand-journalists.ts, never by hand.
CREATE TABLE IF NOT EXISTS brand_journalists (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  press_only boolean NOT NULL,
  journalist boolean NOT NULL,
  basis text,
  first_pitched_at timestamptz,
  pitch_campaign_ids text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id, lead_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_brand_journalists_lead ON brand_journalists (lead_id) WHERE journalist;
