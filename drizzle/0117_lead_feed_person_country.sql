-- The compact lead row (and the change feed's copy of it) now states the PERSON's own country
-- (`lead.country`), so a change to `leads.country` moves the row: note it in the writer's own
-- transaction like a name or seniority change (bound 1 of lead-change-feed.ts), instead of waiting
-- for the next full reconcile. Same function, one more column in the guard.
DROP TRIGGER IF EXISTS trg_lead_read_leads_upd ON leads;
--> statement-breakpoint
CREATE TRIGGER trg_lead_read_leads_upd AFTER UPDATE ON leads
  FOR EACH ROW WHEN (
    (OLD.first_name, OLD.last_name, OLD.photo_url, OLD.seniority, OLD.country)
    IS DISTINCT FROM (NEW.first_name, NEW.last_name, NEW.photo_url, NEW.seniority, NEW.country)
  ) EXECUTE FUNCTION lead_read_note_person();
