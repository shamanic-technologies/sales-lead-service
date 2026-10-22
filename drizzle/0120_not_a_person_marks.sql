-- FAKE-OUTCOMES-1022: our own staff tests must never inflate a brand's figures.
--
-- (1) `not_a_person_marks`: an org states a lead is NOT a real person (a test, a staff mailbox), or the
-- background sweep records that every registered email of the lead is a STAFF identity (basis
-- `staff_identity`, the fleet's isStaffEmail). A live mark takes the lead out of every lead read of the
-- org (lists, counts, read model, compact, change feed) and sets aside its conversion events
-- (`withdrawn_reason = 'not_a_person'`), restored when the last mark is lifted. Org-scoped: one org never
-- hides a lead from another org's figures. Lead-level, not brand-level: a brand transfer leaves it with the org.
CREATE TABLE IF NOT EXISTS "not_a_person_marks" (
  "org_id" text NOT NULL,
  "lead_id" uuid NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "basis" text NOT NULL,
  "note" text,
  "stated_by_user_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "withdrawn_at" timestamptz,
  "withdrawn_by_user_id" text,
  CONSTRAINT "not_a_person_marks_pk" PRIMARY KEY ("org_id", "lead_id", "basis"),
  CONSTRAINT "not_a_person_marks_basis_check" CHECK ("basis" IN ('stated', 'staff_identity'))
);
CREATE INDEX IF NOT EXISTS "idx_napm_live" ON "not_a_person_marks" ("org_id", "lead_id") WHERE "withdrawn_at" IS NULL;

-- A mark moves the person out of (or back into) every read model and change feed of the org.
CREATE OR REPLACE FUNCTION lead_read_note_not_a_person() RETURNS trigger AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO lead_read_changes (org_id, lead_id, kind) VALUES (NEW.org_id, NEW.lead_id, 'statement'), (NEW.org_id, NEW.lead_id, 'lead');
  ELSE
    INSERT INTO lead_read_changes (org_id, lead_id, kind) VALUES (OLD.org_id, OLD.lead_id, 'statement'), (OLD.org_id, OLD.lead_id, 'lead');
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lead_read_napm ON not_a_person_marks;
CREATE TRIGGER trg_lead_read_napm AFTER INSERT OR UPDATE OR DELETE ON not_a_person_marks
  FOR EACH ROW EXECUTE FUNCTION lead_read_note_not_a_person();

-- (2) WHY a conversion was set aside, beside `withdrawn_at`: `wrong_attribution` (a person withdrew it through
-- POST /orgs/brands/{brandId}/conversions/{id}/withdraw, `withdrawn_note` = their words), `staff_identity` (sent by
-- a staff address, set aside at ingest), `not_a_person` (its lead is marked not a real person). NULL = every older
-- withdrawal (a person's step statement, the CRM sync's stale rows). A CRM re-sync never stands up a row with a reason.
ALTER TABLE "conversion_events" ADD COLUMN IF NOT EXISTS "withdrawn_reason" text;
ALTER TABLE "conversion_events" ADD COLUMN IF NOT EXISTS "withdrawn_note" text;

-- Every writer at once (tracker ingest, CRM sync, reply-read sale, a person's statement): a conversion of a lead
-- the org marked not a real person is written set aside, and a CRM re-sync that stands a row back up keeps it aside.
CREATE OR REPLACE FUNCTION conversion_event_not_a_person() RETURNS trigger AS $$
BEGIN
  IF NEW.withdrawn_at IS NULL AND NEW.matched_lead_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM not_a_person_marks m
    WHERE m.org_id = NEW.org_id AND m.lead_id = NEW.matched_lead_id AND m.withdrawn_at IS NULL
  ) THEN
    NEW.withdrawn_at := now();
    NEW.withdrawn_reason := 'not_a_person';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ce_not_a_person ON conversion_events;
CREATE TRIGGER trg_ce_not_a_person BEFORE INSERT OR UPDATE ON conversion_events
  FOR EACH ROW EXECUTE FUNCTION conversion_event_not_a_person();

-- (3) A conversion whose only link to a lead is a NAME (first+last, or last name alone) is not evidence that lead
-- converted (owner: "is this person our lead?" is never a name match; people sign up from another address). Held for
-- review instead of attributed, like the ambiguous domain match: no count reads it. Nothing deleted; the candidate stays.
UPDATE "conversion_events"
SET "attribution_status" = 'needs_review'
WHERE "source" = 'tracker' AND "match_confidence" = 'probabilistic' AND "attribution_status" = 'attributed';
