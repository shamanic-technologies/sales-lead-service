-- BOX-DB-LOAD-1027-LEAD-2: the brand-wide timeline read (`GET /internal/brands/:id/timeline-journeys`) was the most
-- expensive lead-service statement on the shared box (1.5 s average, 8 s on the largest brand under load, its biggest
-- brand asked about twice a minute) while its inputs move a few minutes an hour. Each write to one of its inputs notes
-- the org here, in the writer's transaction (`txid`), so a cached answer is served only while nothing it read has
-- moved since the snapshot it was read in (`brand-journeys-cache.ts`, same rule as the read model's catch-up:
-- "new" = txid >= the reader's snapshot xmin, so a late commit is never missed). Statement-level triggers: one row
-- per org per statement, never per row. Transient (pruned after a day with lead_read_changes), not moved by a brand
-- transfer (a transfer's own writes are noted here for both orgs).
CREATE TABLE IF NOT EXISTS journey_input_changes (
  org_id text NOT NULL,
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jic_org_txid ON journey_input_changes (org_id, txid);
CREATE INDEX IF NOT EXISTS idx_jic_created ON journey_input_changes (created_at);

-- lead_timeline_facts, outreach_facts, followup_actions: the org is on the row.
CREATE OR REPLACE FUNCTION journey_note_new_orgs() RETURNS trigger AS $$
BEGIN
  INSERT INTO journey_input_changes (org_id) SELECT DISTINCT n.org_id FROM journey_new n WHERE n.org_id IS NOT NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION journey_note_old_orgs() RETURNS trigger AS $$
BEGIN
  INSERT INTO journey_input_changes (org_id) SELECT DISTINCT o.org_id FROM journey_old o WHERE o.org_id IS NOT NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION journey_note_both_orgs() RETURNS trigger AS $$
BEGIN
  INSERT INTO journey_input_changes (org_id)
  SELECT org_id FROM journey_new WHERE org_id IS NOT NULL
  UNION
  SELECT org_id FROM journey_old WHERE org_id IS NOT NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journey_ltf_ins ON lead_timeline_facts;
CREATE TRIGGER trg_journey_ltf_ins AFTER INSERT ON lead_timeline_facts
  REFERENCING NEW TABLE AS journey_new FOR EACH STATEMENT EXECUTE FUNCTION journey_note_new_orgs();
DROP TRIGGER IF EXISTS trg_journey_ltf_upd ON lead_timeline_facts;
CREATE TRIGGER trg_journey_ltf_upd AFTER UPDATE ON lead_timeline_facts
  REFERENCING NEW TABLE AS journey_new OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_both_orgs();
DROP TRIGGER IF EXISTS trg_journey_ltf_del ON lead_timeline_facts;
CREATE TRIGGER trg_journey_ltf_del AFTER DELETE ON lead_timeline_facts
  REFERENCING OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_old_orgs();

DROP TRIGGER IF EXISTS trg_journey_of_ins ON outreach_facts;
CREATE TRIGGER trg_journey_of_ins AFTER INSERT ON outreach_facts
  REFERENCING NEW TABLE AS journey_new FOR EACH STATEMENT EXECUTE FUNCTION journey_note_new_orgs();
DROP TRIGGER IF EXISTS trg_journey_of_upd ON outreach_facts;
CREATE TRIGGER trg_journey_of_upd AFTER UPDATE ON outreach_facts
  REFERENCING NEW TABLE AS journey_new OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_both_orgs();
DROP TRIGGER IF EXISTS trg_journey_of_del ON outreach_facts;
CREATE TRIGGER trg_journey_of_del AFTER DELETE ON outreach_facts
  REFERENCING OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_old_orgs();

DROP TRIGGER IF EXISTS trg_journey_fa_ins ON followup_actions;
CREATE TRIGGER trg_journey_fa_ins AFTER INSERT ON followup_actions
  REFERENCING NEW TABLE AS journey_new FOR EACH STATEMENT EXECUTE FUNCTION journey_note_new_orgs();
DROP TRIGGER IF EXISTS trg_journey_fa_upd ON followup_actions;
CREATE TRIGGER trg_journey_fa_upd AFTER UPDATE ON followup_actions
  REFERENCING NEW TABLE AS journey_new OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_both_orgs();
DROP TRIGGER IF EXISTS trg_journey_fa_del ON followup_actions;
CREATE TRIGGER trg_journey_fa_del AFTER DELETE ON followup_actions
  REFERENCING OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_old_orgs();

-- lead_campaign_run_repoints: the org is the re-pointed membership row's. A send is credited to the latest re-point AT
-- OR BEFORE it, so a NEW re-point moves the read only if a live send of that (lead, campaign) is dated at or after it
-- (a retry claim re-points every minute, before the send it hands out exists: that send's own fact notes the org).
CREATE OR REPLACE FUNCTION journey_note_repoint_orgs() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO journey_input_changes (org_id)
    SELECT DISTINCT lc.org_id FROM journey_new n JOIN leads_campaigns lc ON lc.id = n.lead_campaign_id
    WHERE EXISTS (
      SELECT 1 FROM lead_timeline_facts t
      WHERE t.lead_id = lc.lead_id AND t.campaign_id = lc.campaign_id AND t.org_id = lc.org_id
        AND t.label IN ('initial_email', 'followup') AND t.withdrawn_at IS NULL AND t.occurred_at >= n.repointed_at
    );
  END IF;
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO journey_input_changes (org_id)
    SELECT DISTINCT lc.org_id FROM journey_new n JOIN leads_campaigns lc ON lc.id = n.lead_campaign_id;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    INSERT INTO journey_input_changes (org_id)
    SELECT DISTINCT lc.org_id FROM journey_old o JOIN leads_campaigns lc ON lc.id = o.lead_campaign_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journey_rp_ins ON lead_campaign_run_repoints;
CREATE TRIGGER trg_journey_rp_ins AFTER INSERT ON lead_campaign_run_repoints
  REFERENCING NEW TABLE AS journey_new FOR EACH STATEMENT EXECUTE FUNCTION journey_note_repoint_orgs();
DROP TRIGGER IF EXISTS trg_journey_rp_upd ON lead_campaign_run_repoints;
CREATE TRIGGER trg_journey_rp_upd AFTER UPDATE ON lead_campaign_run_repoints
  REFERENCING NEW TABLE AS journey_new OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_repoint_orgs();
DROP TRIGGER IF EXISTS trg_journey_rp_del ON lead_campaign_run_repoints;
CREATE TRIGGER trg_journey_rp_del AFTER DELETE ON lead_campaign_run_repoints
  REFERENCING OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_repoint_orgs();

-- leads_campaigns: the journeys read a row's id and workflow_slug, joined on (lead, campaign, org), for the send facts
-- of that (lead, campaign). Rows are written far more often than that (leases, sends, statuses), so a write is noted
-- only when it can move the read: an insert/delete of a row whose (lead, campaign) holds a live send fact (looked up
-- through idx_ltf_sends_by_lead, the read's own join), or an update of one of the columns the read joins or returns.
CREATE OR REPLACE FUNCTION journey_note_membership_rows() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO journey_input_changes (org_id)
    SELECT DISTINCT t.org_id FROM journey_new n
    JOIN lead_timeline_facts t ON t.lead_id = n.lead_id AND t.campaign_id = n.campaign_id
      AND t.label IN ('initial_email', 'followup') AND t.withdrawn_at IS NULL;
  ELSE
    INSERT INTO journey_input_changes (org_id)
    SELECT DISTINCT t.org_id FROM journey_old o
    JOIN lead_timeline_facts t ON t.lead_id = o.lead_id AND t.campaign_id = o.campaign_id
      AND t.label IN ('initial_email', 'followup') AND t.withdrawn_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journey_lc_ins ON leads_campaigns;
CREATE TRIGGER trg_journey_lc_ins AFTER INSERT ON leads_campaigns
  REFERENCING NEW TABLE AS journey_new FOR EACH STATEMENT EXECUTE FUNCTION journey_note_membership_rows();
DROP TRIGGER IF EXISTS trg_journey_lc_del ON leads_campaigns;
CREATE TRIGGER trg_journey_lc_del AFTER DELETE ON leads_campaigns
  REFERENCING OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_membership_rows();

CREATE OR REPLACE FUNCTION journey_note_membership_update() RETURNS trigger AS $$
BEGIN
  INSERT INTO journey_input_changes (org_id) VALUES (NEW.org_id);
  IF OLD.org_id IS DISTINCT FROM NEW.org_id THEN
    INSERT INTO journey_input_changes (org_id) VALUES (OLD.org_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journey_lc_upd ON leads_campaigns;
CREATE TRIGGER trg_journey_lc_upd AFTER UPDATE ON leads_campaigns
  FOR EACH ROW WHEN (
    (OLD.id, OLD.lead_id, OLD.campaign_id, OLD.org_id, OLD.workflow_slug)
    IS DISTINCT FROM
    (NEW.id, NEW.lead_id, NEW.campaign_id, NEW.org_id, NEW.workflow_slug)
  ) EXECUTE FUNCTION journey_note_membership_update();
