-- Following human-service's identity events (LEAD-REFONTE-1013 step 3, src/lib/human-events.ts).
-- A copy, never a decision: human-service decides "same human?" and carries the facts about a human.
--
-- human_fact_copies   every fact human-service carries on a human (opt_out, do_not_contact), copied
--                     from its FLEET events (human.fact_stated / human.fact_withdrawn). A withdrawn fact
--                     keeps its row with withdrawn_at. Read by the standing (a human's opt-out follows
--                     them to every company) through human_aliases.
-- human_aliases       atomic human -> the human it is in the fleet view, written when a fleet merge
--                     names it (human.linked, relation same, scope fleet). A human with no row is itself.
-- lead_identity_duplicates  two leads of ONE human at ONE company (after a merge, or found twice):
--                     the oldest lead is the one new serves land on (findLeadByHumanCompany); the other
--                     keeps its rows, its id and its email-keyed delivery evidence. Recorded, never folded
--                     physically: a lead's delivery evidence is keyed on its registered email, so moving
--                     one email-holding lead's rows onto another would hide its sends from every count.
CREATE TABLE IF NOT EXISTS human_fact_copies (
  fact_id uuid PRIMARY KEY,
  human_id uuid NOT NULL,
  kind text NOT NULL,
  stated_by_org_id text,
  source text,
  stated_at timestamptz,
  withdrawn_at timestamptz,
  event_id bigint NOT NULL,
  copied_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hfc_human_live ON human_fact_copies (human_id) WHERE withdrawn_at IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS human_aliases (
  atomic_human_id uuid PRIMARY KEY,
  human_id uuid NOT NULL,
  event_id bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_human_aliases_human ON human_aliases (human_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS lead_identity_duplicates (
  lead_id uuid PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
  survivor_lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  human_id uuid NOT NULL,
  company_id uuid NOT NULL,
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lid_survivor ON lead_identity_duplicates (survivor_lead_id);
--> statement-breakpoint
-- The lead's LOCAL company row (owner relay 2026-10-13): most employers are names only (212k of 256k
-- organizations), which brand-service never identifies. A lead's company KEY is its brand id when one
-- is known, else this row (`org:<id>`); a company-level tag keyed on the local row moves to the brand
-- id when one appears. Filled by the identity sweep and on the serve.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS organization_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_human_org ON leads (human_id, organization_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_organization ON leads (organization_id) WHERE organization_id IS NOT NULL;
