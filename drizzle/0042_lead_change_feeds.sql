-- 0042: a CHANGE FEED of each scope's compact lead rows, so a consumer that keeps a copy of a
-- brand's (or a campaign identity's) lead population fetches what changed instead of all of it.
--
-- features-service reads a brand's whole population (`GET /orgs/leads?view=compact`, ~17.8k rows
-- on its busiest brand) on every refresh of a campaign Overview: four pages one after another,
-- 4-9s, and nearly none of those rows changed since the previous refresh a few seconds earlier.
--
--   lead_change_feeds       one row per SCOPE a consumer follows. `version` is the feed's clock:
--                           every change to a row takes the next value, under the feed row's own
--                           lock, so versions commit in the order they are handed out and a reader
--                           asking for "everything after N" can never skip one still in flight.
--   lead_change_feed_rows   one row per compact lead the scope holds, WITH its current payload (the
--                           exact object `view=compact` emits) and the version that last changed
--                           it. A row that left the scope keeps its id with a NULL payload — a
--                           tombstone — so a consumer that holds it is told to drop it.
--
-- The change log (`lead_read_changes`, 0041) gains the writes that move a compact row but never
-- moved a read model row: a lead served, re-pointed or dropped from a campaign, a lead's name, its
-- email, its current employer and that employer's displayed firmographics. Kind 'lead'. The read
-- model ignores that kind (it is rebuilt on its own bound); the feed applies it on its next read.
--
-- Idempotent: a partially-applied state is a no-op.

CREATE TABLE IF NOT EXISTS lead_change_feeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key text NOT NULL UNIQUE,
  org_id text NOT NULL,
  scope jsonb NOT NULL,
  version bigint NOT NULL DEFAULT 0,
  applied_xmin xid8 NOT NULL,
  -- The oldest delivery answer the last full reconcile accepted, and when that reconcile started.
  evidence_at timestamptz,
  reconciled_at timestamptz,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_change_feed_rows (
  feed_id uuid NOT NULL REFERENCES lead_change_feeds(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  lead_id uuid NOT NULL,
  email text,
  -- The row exactly as `view=compact` serializes it: stored as TEXT, not jsonb, so it is served
  -- byte for byte (jsonb would re-order its keys) and never re-parsed on the way out.
  payload text,
  hash text,
  version bigint NOT NULL,
  PRIMARY KEY (feed_id, id)
);

CREATE INDEX IF NOT EXISTS idx_lcfr_version ON lead_change_feed_rows (feed_id, version);
CREATE INDEX IF NOT EXISTS idx_lcfr_lead ON lead_change_feed_rows (feed_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_lcfr_email ON lead_change_feed_rows (feed_id, lower(email));

-- Note a lead as changed for every org that holds it. A lead is a global identity, so the orgs
-- come from its memberships.
CREATE OR REPLACE FUNCTION lead_read_note_lead_everywhere(changed uuid) RETURNS void AS $$
BEGIN
  INSERT INTO lead_read_changes (org_id, lead_id, kind)
  SELECT DISTINCT lc.org_id, changed, 'lead' FROM leads_campaigns lc WHERE lc.lead_id = changed;
END;
$$ LANGUAGE plpgsql;

-- A membership row: served, re-pointed, re-statused, moved between campaigns, or removed.
CREATE OR REPLACE FUNCTION lead_read_note_membership() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO lead_read_changes (org_id, lead_id, kind) VALUES (NEW.org_id, NEW.lead_id, 'lead');
  END IF;
  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.lead_id IS DISTINCT FROM NEW.lead_id
                            OR OLD.org_id IS DISTINCT FROM NEW.org_id) THEN
    INSERT INTO lead_read_changes (org_id, lead_id, kind) VALUES (OLD.org_id, OLD.lead_id, 'lead');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_read_lc_ins_del ON leads_campaigns;
CREATE TRIGGER trg_lead_read_lc_ins_del AFTER INSERT OR DELETE ON leads_campaigns
  FOR EACH ROW EXECUTE FUNCTION lead_read_note_membership();
-- Only the columns a compact row or the per-person dedup reads: the retry lease, the follow-up
-- queue and the send markers are written far more often and change nothing a consumer holds.
DROP TRIGGER IF EXISTS trg_lead_read_lc_upd ON leads_campaigns;
CREATE TRIGGER trg_lead_read_lc_upd AFTER UPDATE ON leads_campaigns
  FOR EACH ROW WHEN (
    (OLD.lead_id, OLD.org_id, OLD.campaign_id, OLD.brand_ids, OLD.status, OLD.workflow_slug,
     OLD.user_id, OLD.served_at, OLD.created_at)
    IS DISTINCT FROM
    (NEW.lead_id, NEW.org_id, NEW.campaign_id, NEW.brand_ids, NEW.status, NEW.workflow_slug,
     NEW.user_id, NEW.served_at, NEW.created_at)
  ) EXECUTE FUNCTION lead_read_note_membership();

-- The person: name, photo, seniority.
CREATE OR REPLACE FUNCTION lead_read_note_person() RETURNS trigger AS $$
BEGIN
  PERFORM lead_read_note_lead_everywhere(NEW.id);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_read_leads_upd ON leads;
CREATE TRIGGER trg_lead_read_leads_upd AFTER UPDATE ON leads
  FOR EACH ROW WHEN (
    (OLD.first_name, OLD.last_name, OLD.photo_url, OLD.seniority)
    IS DISTINCT FROM (NEW.first_name, NEW.last_name, NEW.photo_url, NEW.seniority)
  ) EXECUTE FUNCTION lead_read_note_person();

-- The person's email and their employment rows (which one is current, and the title on it).
CREATE OR REPLACE FUNCTION lead_read_note_lead_child() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM lead_read_note_lead_everywhere(NEW.lead_id);
  END IF;
  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.lead_id IS DISTINCT FROM NEW.lead_id) THEN
    PERFORM lead_read_note_lead_everywhere(OLD.lead_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_read_lcm ON lead_contact_methods;
CREATE TRIGGER trg_lead_read_lcm AFTER INSERT OR UPDATE OR DELETE ON lead_contact_methods
  FOR EACH ROW EXECUTE FUNCTION lead_read_note_lead_child();
DROP TRIGGER IF EXISTS trg_lead_read_lo ON leads_organizations;
CREATE TRIGGER trg_lead_read_lo AFTER INSERT OR UPDATE OR DELETE ON leads_organizations
  FOR EACH ROW EXECUTE FUNCTION lead_read_note_lead_child();

-- An employer's displayed firmographics, for everybody employed there.
-- Reached by organization, which nothing indexed: without it every changed employer is a scan of
-- every employment row (~385k in production).
CREATE INDEX IF NOT EXISTS idx_lo_org ON leads_organizations (organization_id);

CREATE OR REPLACE FUNCTION lead_read_note_organization() RETURNS trigger AS $$
BEGIN
  INSERT INTO lead_read_changes (org_id, lead_id, kind)
  SELECT DISTINCT lc.org_id, lo.lead_id, 'lead'
  FROM leads_organizations lo
  JOIN leads_campaigns lc ON lc.lead_id = lo.lead_id
  WHERE lo.organization_id = NEW.id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_read_org_upd ON organizations;
CREATE TRIGGER trg_lead_read_org_upd AFTER UPDATE ON organizations
  FOR EACH ROW WHEN (
    (OLD.name, OLD.logo_url, OLD.primary_domain, OLD.website_url, OLD.industry,
     OLD.estimated_num_employees, OLD.city, OLD.country)
    IS DISTINCT FROM
    (NEW.name, NEW.logo_url, NEW.primary_domain, NEW.website_url, NEW.industry,
     NEW.estimated_num_employees, NEW.city, NEW.country)
  ) EXECUTE FUNCTION lead_read_note_organization();
