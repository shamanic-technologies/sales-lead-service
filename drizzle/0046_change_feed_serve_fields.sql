-- A compact row now carries `lastServedAt` (COALESCE(retry_claimed_at, served_at)) and
-- `audienceId`, so a change to either column must note the lead for the change feed exactly like
-- the other columns a compact row reads. The retry lease is written once per re-hand-out of a paid
-- serve (not per poll), so adding it here costs one change per re-serve.
DROP TRIGGER IF EXISTS trg_lead_read_lc_upd ON leads_campaigns;
CREATE TRIGGER trg_lead_read_lc_upd AFTER UPDATE ON leads_campaigns
  FOR EACH ROW WHEN (
    (OLD.lead_id, OLD.org_id, OLD.campaign_id, OLD.brand_ids, OLD.status, OLD.workflow_slug,
     OLD.user_id, OLD.served_at, OLD.created_at, OLD.retry_claimed_at, OLD.audience_id)
    IS DISTINCT FROM
    (NEW.lead_id, NEW.org_id, NEW.campaign_id, NEW.brand_ids, NEW.status, NEW.workflow_slug,
     NEW.user_id, NEW.served_at, NEW.created_at, NEW.retry_claimed_at, NEW.audience_id)
  ) EXECUTE FUNCTION lead_read_note_membership();
