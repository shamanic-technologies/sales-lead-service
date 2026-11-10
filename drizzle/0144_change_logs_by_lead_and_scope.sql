-- DASH-SPEED-1110-LEAD-R4: compute when inputs change, serve what is kept.
--
-- 1. timeline-journeys (brand-journeys-cache.ts): the change log named only the ORG, so one outreach send anywhere in the
--    org threw the whole cached answer away and the next read re-ran the brand-wide aggregate (~1-3 s, 142k buffers on
--    the largest brand). Each change now also names WHICH lead moved (or which outreach subject, resolved to its lead
--    at read time through the timeline row it feeds), so a read recomputes only those leads' journeys. A row naming
--    neither (NULL, NULL) still means "anything of the org may have moved": full recompute.
ALTER TABLE journey_input_changes ADD COLUMN IF NOT EXISTS lead_id uuid;
ALTER TABLE journey_input_changes ADD COLUMN IF NOT EXISTS subject_key text;

-- lead_timeline_facts, followup_actions: the lead is on the row.
CREATE OR REPLACE FUNCTION journey_note_new_leads() RETURNS trigger AS $$
BEGIN
  INSERT INTO journey_input_changes (org_id, lead_id)
  SELECT DISTINCT n.org_id, n.lead_id FROM journey_new n WHERE n.org_id IS NOT NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION journey_note_old_leads() RETURNS trigger AS $$
BEGIN
  INSERT INTO journey_input_changes (org_id, lead_id)
  SELECT DISTINCT o.org_id, o.lead_id FROM journey_old o WHERE o.org_id IS NOT NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION journey_note_both_leads() RETURNS trigger AS $$
BEGIN
  INSERT INTO journey_input_changes (org_id, lead_id)
  SELECT org_id, lead_id FROM journey_new WHERE org_id IS NOT NULL
  UNION
  SELECT org_id, lead_id FROM journey_old WHERE org_id IS NOT NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- outreach_facts: the read joins a fact to the timeline row whose id is its subject key; the lead is resolved at read
-- time (a timeline row written later notes its own lead).
CREATE OR REPLACE FUNCTION journey_note_new_subjects() RETURNS trigger AS $$
BEGIN
  INSERT INTO journey_input_changes (org_id, subject_key)
  SELECT DISTINCT n.org_id, n.subject_key FROM journey_new n WHERE n.org_id IS NOT NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION journey_note_old_subjects() RETURNS trigger AS $$
BEGIN
  INSERT INTO journey_input_changes (org_id, subject_key)
  SELECT DISTINCT o.org_id, o.subject_key FROM journey_old o WHERE o.org_id IS NOT NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION journey_note_both_subjects() RETURNS trigger AS $$
BEGIN
  INSERT INTO journey_input_changes (org_id, subject_key)
  SELECT org_id, subject_key FROM journey_new WHERE org_id IS NOT NULL
  UNION
  SELECT org_id, subject_key FROM journey_old WHERE org_id IS NOT NULL;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_journey_ltf_ins ON lead_timeline_facts;
CREATE TRIGGER trg_journey_ltf_ins AFTER INSERT ON lead_timeline_facts
  REFERENCING NEW TABLE AS journey_new FOR EACH STATEMENT EXECUTE FUNCTION journey_note_new_leads();
DROP TRIGGER IF EXISTS trg_journey_ltf_upd ON lead_timeline_facts;
CREATE TRIGGER trg_journey_ltf_upd AFTER UPDATE ON lead_timeline_facts
  REFERENCING NEW TABLE AS journey_new OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_both_leads();
DROP TRIGGER IF EXISTS trg_journey_ltf_del ON lead_timeline_facts;
CREATE TRIGGER trg_journey_ltf_del AFTER DELETE ON lead_timeline_facts
  REFERENCING OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_old_leads();

DROP TRIGGER IF EXISTS trg_journey_of_ins ON outreach_facts;
CREATE TRIGGER trg_journey_of_ins AFTER INSERT ON outreach_facts
  REFERENCING NEW TABLE AS journey_new FOR EACH STATEMENT EXECUTE FUNCTION journey_note_new_subjects();
DROP TRIGGER IF EXISTS trg_journey_of_upd ON outreach_facts;
CREATE TRIGGER trg_journey_of_upd AFTER UPDATE ON outreach_facts
  REFERENCING NEW TABLE AS journey_new OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_both_subjects();
DROP TRIGGER IF EXISTS trg_journey_of_del ON outreach_facts;
CREATE TRIGGER trg_journey_of_del AFTER DELETE ON outreach_facts
  REFERENCING OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_old_subjects();

DROP TRIGGER IF EXISTS trg_journey_fa_ins ON followup_actions;
CREATE TRIGGER trg_journey_fa_ins AFTER INSERT ON followup_actions
  REFERENCING NEW TABLE AS journey_new FOR EACH STATEMENT EXECUTE FUNCTION journey_note_new_leads();
DROP TRIGGER IF EXISTS trg_journey_fa_upd ON followup_actions;
CREATE TRIGGER trg_journey_fa_upd AFTER UPDATE ON followup_actions
  REFERENCING NEW TABLE AS journey_new OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_both_leads();
DROP TRIGGER IF EXISTS trg_journey_fa_del ON followup_actions;
CREATE TRIGGER trg_journey_fa_del AFTER DELETE ON followup_actions
  REFERENCING OLD TABLE AS journey_old FOR EACH STATEMENT EXECUTE FUNCTION journey_note_old_leads();

-- lead_campaign_run_repoints: same conditions as 0128, now naming the re-pointed row's lead.
CREATE OR REPLACE FUNCTION journey_note_repoint_orgs() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO journey_input_changes (org_id, lead_id)
    SELECT DISTINCT lc.org_id, lc.lead_id FROM journey_new n JOIN leads_campaigns lc ON lc.id = n.lead_campaign_id
    WHERE EXISTS (
      SELECT 1 FROM lead_timeline_facts t
      WHERE t.lead_id = lc.lead_id AND t.campaign_id = lc.campaign_id AND t.org_id = lc.org_id
        AND t.label IN ('initial_email', 'followup') AND t.withdrawn_at IS NULL AND t.occurred_at >= n.repointed_at
    );
  END IF;
  IF TG_OP = 'UPDATE' THEN
    INSERT INTO journey_input_changes (org_id, lead_id)
    SELECT DISTINCT lc.org_id, lc.lead_id FROM journey_new n JOIN leads_campaigns lc ON lc.id = n.lead_campaign_id;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    INSERT INTO journey_input_changes (org_id, lead_id)
    SELECT DISTINCT lc.org_id, lc.lead_id FROM journey_old o JOIN leads_campaigns lc ON lc.id = o.lead_campaign_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- leads_campaigns: same conditions as 0128, now naming the lead.
CREATE OR REPLACE FUNCTION journey_note_membership_rows() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO journey_input_changes (org_id, lead_id)
    SELECT DISTINCT t.org_id, n.lead_id FROM journey_new n
    JOIN lead_timeline_facts t ON t.lead_id = n.lead_id AND t.campaign_id = n.campaign_id
      AND t.label IN ('initial_email', 'followup') AND t.withdrawn_at IS NULL;
  ELSE
    INSERT INTO journey_input_changes (org_id, lead_id)
    SELECT DISTINCT t.org_id, o.lead_id FROM journey_old o
    JOIN lead_timeline_facts t ON t.lead_id = o.lead_id AND t.campaign_id = o.campaign_id
      AND t.label IN ('initial_email', 'followup') AND t.withdrawn_at IS NULL;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION journey_note_membership_update() RETURNS trigger AS $$
BEGIN
  INSERT INTO journey_input_changes (org_id, lead_id) VALUES (NEW.org_id, NEW.lead_id);
  IF (OLD.org_id, OLD.lead_id) IS DISTINCT FROM (NEW.org_id, NEW.lead_id) THEN
    INSERT INTO journey_input_changes (org_id, lead_id) VALUES (OLD.org_id, OLD.lead_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- 2. their-acts (`refreshActedAt`, every 2 min) re-derived `last_action_at` of EVERY scope on every pass. Each write
--    to one of its inputs now notes the (org, brand) it can move, in the writer's transaction; a pass re-derives only a
--    scope with a change at or after the snapshot xmin of its last pass (`acted_scope_passes`).
CREATE TABLE IF NOT EXISTS acted_input_changes (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aic_scope_txid ON acted_input_changes (org_id, brand_id, txid);
CREATE INDEX IF NOT EXISTS idx_aic_created ON acted_input_changes (created_at);

CREATE TABLE IF NOT EXISTS acted_scope_passes (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  -- `last_action_at` of the scope was re-derived from a snapshot whose xmin is this (taken before the pass).
  acted_xmin xid8,
  acted_at timestamptz,
  -- No inbound message of the scope waited on a judgment as of a snapshot whose xmin is this.
  judged_xmin xid8,
  judged_at timestamptz,
  PRIMARY KEY (org_id, brand_id)
);

-- lead_crm_acts, relationship_subjects, lead_followup_dates: the scope is on the row.
CREATE OR REPLACE FUNCTION acted_note_new_scopes() RETURNS trigger AS $$
BEGIN
  INSERT INTO acted_input_changes (org_id, brand_id) SELECT DISTINCT n.org_id, n.brand_id FROM acted_new n;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION acted_note_old_scopes() RETURNS trigger AS $$
BEGIN
  INSERT INTO acted_input_changes (org_id, brand_id) SELECT DISTINCT o.org_id, o.brand_id FROM acted_old o;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION acted_note_row_scope() RETURNS trigger AS $$
BEGIN
  INSERT INTO acted_input_changes (org_id, brand_id) VALUES (NEW.org_id, NEW.brand_id);
  IF (OLD.org_id, OLD.brand_id) IS DISTINCT FROM (NEW.org_id, NEW.brand_id) THEN
    INSERT INTO acted_input_changes (org_id, brand_id) VALUES (OLD.org_id, OLD.brand_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_acted_lca_ins ON lead_crm_acts;
CREATE TRIGGER trg_acted_lca_ins AFTER INSERT ON lead_crm_acts
  REFERENCING NEW TABLE AS acted_new FOR EACH STATEMENT EXECUTE FUNCTION acted_note_new_scopes();
DROP TRIGGER IF EXISTS trg_acted_lca_del ON lead_crm_acts;
CREATE TRIGGER trg_acted_lca_del AFTER DELETE ON lead_crm_acts
  REFERENCING OLD TABLE AS acted_old FOR EACH STATEMENT EXECUTE FUNCTION acted_note_old_scopes();
DROP TRIGGER IF EXISTS trg_acted_lca_upd ON lead_crm_acts;
CREATE TRIGGER trg_acted_lca_upd AFTER UPDATE ON lead_crm_acts
  FOR EACH ROW WHEN (OLD IS DISTINCT FROM NEW) EXECUTE FUNCTION acted_note_row_scope();

-- relationship_subjects: the sweep rewrites rows constantly; only the contact points (and the keys) feed the acts.
DROP TRIGGER IF EXISTS trg_acted_rs_ins ON relationship_subjects;
CREATE TRIGGER trg_acted_rs_ins AFTER INSERT ON relationship_subjects
  REFERENCING NEW TABLE AS acted_new FOR EACH STATEMENT EXECUTE FUNCTION acted_note_new_scopes();
DROP TRIGGER IF EXISTS trg_acted_rs_del ON relationship_subjects;
CREATE TRIGGER trg_acted_rs_del AFTER DELETE ON relationship_subjects
  REFERENCING OLD TABLE AS acted_old FOR EACH STATEMENT EXECUTE FUNCTION acted_note_old_scopes();
DROP TRIGGER IF EXISTS trg_acted_rs_upd ON relationship_subjects;
CREATE TRIGGER trg_acted_rs_upd AFTER UPDATE ON relationship_subjects
  FOR EACH ROW WHEN (
    (OLD.org_id, OLD.brand_id, OLD.contact_points) IS DISTINCT FROM (NEW.org_id, NEW.brand_id, NEW.contact_points)
  ) EXECUTE FUNCTION acted_note_row_scope();

-- lead_followup_dates: a date row appearing or leaving is an input (the UPDATE targets existing rows); its other
-- columns (the date itself, written every 2 min) are not, and `last_action_at` is this pass's own output.
DROP TRIGGER IF EXISTS trg_acted_lfd_ins ON lead_followup_dates;
CREATE TRIGGER trg_acted_lfd_ins AFTER INSERT ON lead_followup_dates
  REFERENCING NEW TABLE AS acted_new FOR EACH STATEMENT EXECUTE FUNCTION acted_note_new_scopes();
DROP TRIGGER IF EXISTS trg_acted_lfd_del ON lead_followup_dates;
CREATE TRIGGER trg_acted_lfd_del AFTER DELETE ON lead_followup_dates
  REFERENCING OLD TABLE AS acted_old FOR EACH STATEMENT EXECUTE FUNCTION acted_note_old_scopes();
DROP TRIGGER IF EXISTS trg_acted_lfd_upd ON lead_followup_dates;
CREATE TRIGGER trg_acted_lfd_upd AFTER UPDATE ON lead_followup_dates
  FOR EACH ROW WHEN (
    (OLD.org_id, OLD.brand_id, OLD.lead_id) IS DISTINCT FROM (NEW.org_id, NEW.brand_id, NEW.lead_id)
  ) EXECUTE FUNCTION acted_note_row_scope();

-- crm_registry_facts: a crm conversation tag of the scope, or the withdrawal of one (noted under the TAG's scope, which
-- is the one the pass reads, and under the withdrawal's own).
CREATE OR REPLACE FUNCTION acted_note_registry() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO acted_input_changes (org_id, brand_id)
    SELECT n.org_id, n.brand_id FROM acted_new n WHERE n.type = 'connection_tag' OR n.withdrawn_of IS NOT NULL
    UNION
    SELECT r.org_id, r.brand_id FROM acted_new n JOIN crm_registry_facts r ON r.fact_id = n.withdrawn_of
    WHERE r.type = 'connection_tag';
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    INSERT INTO acted_input_changes (org_id, brand_id)
    SELECT o.org_id, o.brand_id FROM acted_old o WHERE o.type = 'connection_tag' OR o.withdrawn_of IS NOT NULL
    UNION
    SELECT r.org_id, r.brand_id FROM acted_old o JOIN crm_registry_facts r ON r.fact_id = o.withdrawn_of
    WHERE r.type = 'connection_tag';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_acted_crf_ins ON crm_registry_facts;
CREATE TRIGGER trg_acted_crf_ins AFTER INSERT ON crm_registry_facts
  REFERENCING NEW TABLE AS acted_new FOR EACH STATEMENT EXECUTE FUNCTION acted_note_registry();
DROP TRIGGER IF EXISTS trg_acted_crf_upd ON crm_registry_facts;
CREATE TRIGGER trg_acted_crf_upd AFTER UPDATE ON crm_registry_facts
  REFERENCING NEW TABLE AS acted_new OLD TABLE AS acted_old FOR EACH STATEMENT EXECUTE FUNCTION acted_note_registry();
DROP TRIGGER IF EXISTS trg_acted_crf_del ON crm_registry_facts;
CREATE TRIGGER trg_acted_crf_del AFTER DELETE ON crm_registry_facts
  REFERENCING OLD TABLE AS acted_old FOR EACH STATEMENT EXECUTE FUNCTION acted_note_registry();

-- crm_facts: only a withdrawal of an act's fact is read; noted under every scope holding that act.
CREATE OR REPLACE FUNCTION acted_note_crm_withdrawals() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO acted_input_changes (org_id, brand_id)
    SELECT DISTINCT a.org_id, a.brand_id FROM acted_new n JOIN lead_crm_acts a ON a.fact_id = n.withdrawn_of
    WHERE n.withdrawn_of IS NOT NULL;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    INSERT INTO acted_input_changes (org_id, brand_id)
    SELECT DISTINCT a.org_id, a.brand_id FROM acted_old o JOIN lead_crm_acts a ON a.fact_id = o.withdrawn_of
    WHERE o.withdrawn_of IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_acted_cf_ins ON crm_facts;
CREATE TRIGGER trg_acted_cf_ins AFTER INSERT ON crm_facts
  REFERENCING NEW TABLE AS acted_new FOR EACH STATEMENT EXECUTE FUNCTION acted_note_crm_withdrawals();
DROP TRIGGER IF EXISTS trg_acted_cf_upd ON crm_facts;
CREATE TRIGGER trg_acted_cf_upd AFTER UPDATE ON crm_facts
  REFERENCING NEW TABLE AS acted_new OLD TABLE AS acted_old FOR EACH STATEMENT EXECUTE FUNCTION acted_note_crm_withdrawals();
DROP TRIGGER IF EXISTS trg_acted_cf_del ON crm_facts;
CREATE TRIGGER trg_acted_cf_del AFTER DELETE ON crm_facts
  REFERENCING OLD TABLE AS acted_old FOR EACH STATEMENT EXECUTE FUNCTION acted_note_crm_withdrawals();

-- crm_act_judgments: a message judged (a person or a machine) moves every scope holding it as an act.
CREATE OR REPLACE FUNCTION acted_note_judgments() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO acted_input_changes (org_id, brand_id)
    SELECT DISTINCT a.org_id, a.brand_id FROM acted_new n JOIN lead_crm_acts a ON a.fact_id = n.fact_id;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    INSERT INTO acted_input_changes (org_id, brand_id)
    SELECT DISTINCT a.org_id, a.brand_id FROM acted_old o JOIN lead_crm_acts a ON a.fact_id = o.fact_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_acted_caj_ins ON crm_act_judgments;
CREATE TRIGGER trg_acted_caj_ins AFTER INSERT ON crm_act_judgments
  REFERENCING NEW TABLE AS acted_new FOR EACH STATEMENT EXECUTE FUNCTION acted_note_judgments();
DROP TRIGGER IF EXISTS trg_acted_caj_upd ON crm_act_judgments;
CREATE TRIGGER trg_acted_caj_upd AFTER UPDATE ON crm_act_judgments
  REFERENCING NEW TABLE AS acted_new OLD TABLE AS acted_old FOR EACH STATEMENT EXECUTE FUNCTION acted_note_judgments();
DROP TRIGGER IF EXISTS trg_acted_caj_del ON crm_act_judgments;
CREATE TRIGGER trg_acted_caj_del AFTER DELETE ON crm_act_judgments
  REFERENCING OLD TABLE AS acted_old FOR EACH STATEMENT EXECUTE FUNCTION acted_note_judgments();

-- 3. The relationship sweep's whole-brand read of live crm relations (relationship-subjects.ts `liveRelations`, ~780 ms
--    a call: 415k relation facts of one brand, 41k live) is kept per brand and brought up to date from the facts copied
--    since. Each write to the registry copy notes the lowest seq it wrote (`min_seq`), in the writer's transaction, so a
--    copy that committed late is re-read from its own seq; an UPDATE or DELETE (a brand transfer) means "re-read all".
CREATE TABLE IF NOT EXISTS crm_registry_fact_changes (
  min_seq bigint,
  full_reload boolean NOT NULL DEFAULT false,
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crfc_txid ON crm_registry_fact_changes (txid);
CREATE INDEX IF NOT EXISTS idx_crfc_created ON crm_registry_fact_changes (created_at);

CREATE OR REPLACE FUNCTION registry_note_inserted() RETURNS trigger AS $$
BEGIN
  INSERT INTO crm_registry_fact_changes (min_seq)
  SELECT min(n.seq) FROM registry_new n HAVING count(*) > 0;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION registry_note_updated() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM registry_new) THEN
    INSERT INTO crm_registry_fact_changes (min_seq, full_reload) VALUES (NULL, true);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION registry_note_deleted() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM registry_old) THEN
    INSERT INTO crm_registry_fact_changes (min_seq, full_reload) VALUES (NULL, true);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_registry_changes_ins ON crm_registry_facts;
CREATE TRIGGER trg_registry_changes_ins AFTER INSERT ON crm_registry_facts
  REFERENCING NEW TABLE AS registry_new FOR EACH STATEMENT EXECUTE FUNCTION registry_note_inserted();
DROP TRIGGER IF EXISTS trg_registry_changes_upd ON crm_registry_facts;
CREATE TRIGGER trg_registry_changes_upd AFTER UPDATE ON crm_registry_facts
  REFERENCING NEW TABLE AS registry_new FOR EACH STATEMENT EXECUTE FUNCTION registry_note_updated();
DROP TRIGGER IF EXISTS trg_registry_changes_del ON crm_registry_facts;
CREATE TRIGGER trg_registry_changes_del AFTER DELETE ON crm_registry_facts
  REFERENCING OLD TABLE AS registry_old FOR EACH STATEMENT EXECUTE FUNCTION registry_note_deleted();
