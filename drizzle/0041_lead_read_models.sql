-- 0041: the Leads page reads a MODEL of each scope instead of recomputing the scope per request.
--
-- Every read the customer's Leads page makes (tab counts, one tab's page, the board's standing
-- counts, one column's page) used to walk the WHOLE scoped population on every request: re-dedup
-- it chunk by chunk, ask email-gateway about every address in it, read the outcome ledger and the
-- statements, and resolve a standing per person — 7-9s per read on a 17,910-person brand, five
-- reads per page load, re-polled every 15s per open tab (27-30s under that load). Nothing was kept.
--
--   lead_delivery_evidence   what email-gateway last said about an address, keyed exactly like the
--                            question (org, brand asked, campaign mode, email), with WHEN it was
--                            asked. Shared by every model of the same brand.
--   lead_read_models         one row per SCOPE (brand, campaign identity, offer, statuses...) the
--                            page reads. `evidence_at` is the age bound: no evidence the model was
--                            built from is older than it. `applied_xmin` is how far the change log
--                            has been applied.
--   lead_read_model_rows     one row per person in the scope: its buckets, its standing, the instant
--                            that dates it, and the text it is searched by. A count is a GROUP BY and
--                            a page is an ORDER BY ... LIMIT over these, so a tab's count and the
--                            rows the tab returns are the same set by construction.
--   lead_read_changes        the change log that makes a PERSON's statement show on the very next
--                            read: a trigger on each statement store writes the lead it touched, in
--                            the writer's own transaction, and a read applies what is new before it
--                            answers. `txid` (the writer's transaction id) is what makes "new" exact
--                            under concurrent commits: a read re-applies everything from transactions
--                            that were still open when it last looked, never skips one.
--
-- Idempotent: a partially-applied state is a no-op.

CREATE TABLE IF NOT EXISTS lead_delivery_evidence (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  campaign_id text NOT NULL DEFAULT '',
  email text NOT NULL,
  result jsonb,
  fetched_at timestamptz NOT NULL,
  PRIMARY KEY (org_id, brand_id, campaign_id, email)
);

CREATE TABLE IF NOT EXISTS lead_read_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key text UNIQUE,
  org_id text NOT NULL,
  scope jsonb NOT NULL,
  evidence_at timestamptz,
  applied_xmin xid8 NOT NULL,
  built_at timestamptz,
  -- Set when a newer build of the same scope replaced this one. A read that picked this model up a
  -- moment before the swap still reads it whole; it is deleted once no read can still hold it.
  retired_at timestamptz,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lead_read_model_rows (
  model_id uuid NOT NULL REFERENCES lead_read_models(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  lead_id uuid NOT NULL,
  email text,
  created_at_text text COLLATE "C" NOT NULL,
  activity_at timestamptz NOT NULL,
  buckets text[] NOT NULL,
  standing text NOT NULL,
  search_text text NOT NULL,
  PRIMARY KEY (model_id, id)
);

CREATE INDEX IF NOT EXISTS idx_lrmr_lead ON lead_read_model_rows (model_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_lrmr_email ON lead_read_model_rows (model_id, lower(email));
CREATE INDEX IF NOT EXISTS idx_lrmr_activity ON lead_read_model_rows (model_id, activity_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_lrmr_created ON lead_read_model_rows (model_id, created_at_text, id);

CREATE TABLE IF NOT EXISTS lead_read_changes (
  seq bigserial PRIMARY KEY,
  org_id text NOT NULL,
  lead_id uuid,
  email text,
  kind text NOT NULL,
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lrc_org_txid ON lead_read_changes (org_id, txid);
CREATE INDEX IF NOT EXISTS idx_lrc_created ON lead_read_changes (created_at);

-- An outcome (hand-stated, tracker-reported or CRM-evidenced) moves a person's buckets, standing
-- and activity date. Both the new and the old matched lead are noted: a re-pointed row changes two
-- people.
CREATE OR REPLACE FUNCTION lead_read_note_conversion_event() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'DELETE' AND NEW.matched_lead_id IS NOT NULL THEN
    INSERT INTO lead_read_changes (org_id, lead_id, kind) VALUES (NEW.org_id, NEW.matched_lead_id, 'statement');
  END IF;
  IF TG_OP <> 'INSERT' AND OLD.matched_lead_id IS NOT NULL
     AND (TG_OP = 'DELETE' OR OLD.matched_lead_id IS DISTINCT FROM NEW.matched_lead_id) THEN
    INSERT INTO lead_read_changes (org_id, lead_id, kind) VALUES (OLD.org_id, OLD.matched_lead_id, 'statement');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- A "never" moves a person's standing (and, retracted or withdrawn, moves it back).
CREATE OR REPLACE FUNCTION lead_read_note_disqualification() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO lead_read_changes (org_id, lead_id, kind) VALUES (NEW.org_id, NEW.lead_id, 'statement');
  END IF;
  IF TG_OP <> 'INSERT' AND (TG_OP = 'DELETE' OR OLD.lead_id IS DISTINCT FROM NEW.lead_id) THEN
    INSERT INTO lead_read_changes (org_id, lead_id, kind) VALUES (OLD.org_id, OLD.lead_id, 'statement');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_read_ce_ins_del ON conversion_events;
CREATE TRIGGER trg_lead_read_ce_ins_del AFTER INSERT OR DELETE ON conversion_events
  FOR EACH ROW EXECUTE FUNCTION lead_read_note_conversion_event();
DROP TRIGGER IF EXISTS trg_lead_read_ce_upd ON conversion_events;
CREATE TRIGGER trg_lead_read_ce_upd AFTER UPDATE ON conversion_events
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION lead_read_note_conversion_event();

DROP TRIGGER IF EXISTS trg_lead_read_lsd_ins_del ON lead_step_disqualifications;
CREATE TRIGGER trg_lead_read_lsd_ins_del AFTER INSERT OR DELETE ON lead_step_disqualifications
  FOR EACH ROW EXECUTE FUNCTION lead_read_note_disqualification();
DROP TRIGGER IF EXISTS trg_lead_read_lsd_upd ON lead_step_disqualifications;
CREATE TRIGGER trg_lead_read_lsd_upd AFTER UPDATE ON lead_step_disqualifications
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION lead_read_note_disqualification();
