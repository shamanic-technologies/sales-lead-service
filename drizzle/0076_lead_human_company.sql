-- A lead is a HUMAN (human-service) at a COMPANY (brand-service) (owner 2026-10-13, LEAD-REFONTE-1013).
-- The person lives in human-service (fleet-wide `humanId`), the company in brand-service (a brand row:
-- same domain = same id), the lead here. Existing lead ids NEVER change: each existing lead is (its
-- human, its CURRENT employer's company), filled by the background identity sweep
-- (src/lib/lead-identity-sweep.ts), never by this migration and never before listen().
--
-- leads.human_id      the human in the FLEET view (no org: a lead row is global, orgs share it).
--                     NULL = not resolved yet, or the lead holds no key human-service accepts.
-- leads.company_id    the brand-service brand id of the company the lead is AT. NULL = no safe
--                     company identity (name-only employer, no employer), still a lead.
-- leads.identity_resolved_at  when the sweep last resolved both; NULL = waiting for the sweep.
-- organizations.company_id / company_resolved_at / company_unresolved_reason: the employer row's
--                     company, resolved once per row (domain, else LinkedIn page, else Apollo org id).
-- organizations.company_facts_pushed_at: when this row's firmographics were last written to
--                     brand-service (the company facts' home); NULL = not written yet.
-- The read-model / change-feed triggers are column-guarded (0042): none of these columns fires them.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS human_id uuid;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN IF NOT EXISTS company_id uuid;
--> statement-breakpoint
ALTER TABLE leads ADD COLUMN IF NOT EXISTS identity_resolved_at timestamptz;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS company_id uuid;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS company_resolved_at timestamptz;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS company_unresolved_reason text;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS company_facts_pushed_at timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_human_company ON leads (human_id, company_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_company ON leads (company_id) WHERE company_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_leads_identity_pending ON leads (created_at, id) WHERE identity_resolved_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_organizations_company ON organizations (company_id) WHERE company_id IS NOT NULL;
--> statement-breakpoint
-- The sweep's employer pass walks CURRENT employers only (past employers are mostly name-only).
CREATE INDEX IF NOT EXISTS idx_lo_current_org ON leads_organizations (organization_id) WHERE current = true;
