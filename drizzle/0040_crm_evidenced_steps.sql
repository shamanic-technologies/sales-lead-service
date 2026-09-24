-- 0040: what the customer's OWN CRM evidences about a lead we emailed counts on our funnel steps.
--
-- A customer runs their own CRM and we mirror it (crm-service). For a CRM contact PAIRED with one of
-- our leads (crm-pairing.ts: paired only — never unconfirmed, never rejected), crm-service serves
-- dated funnel events: a meeting booked / attended / not held, a deal won / lost. Those are facts
-- about our funnel steps that nobody here had, so a lead whose deal their CRM shows WON read as a
-- mere "Contacted" beside a CRM Merged row saying "We are behind".
--
-- The evidence is written onto the SAME two stores every step read already reads, tagged
-- `source = 'crm'`, so the leads board, the standing, the closed deal, the counts and
-- features-service's per-row outcome reads pick it up with no consumer learning about CRMs:
--
--   - an OUTCOME (meeting_booked, meeting_attended, sale) is a `conversion_events` row keyed to the
--     PERSON (lead_campaign_id NULL, exactly like a tracker event), deduped per (brand, lead, step);
--   - a NEVER (a meeting not held -> meeting_attended, a deal lost -> sale) is a
--     `lead_step_disqualifications` row per campaign row of the person, `source = 'crm'`.
--
-- `received_at` becomes NULLABLE: a CRM event GoHighLevel gave no date for is UNDATED, and every
-- read already answers an undated outcome in its `undated` bucket rather than on a fabricated day.
-- The default stays, so every existing writer is unaffected.
--
-- `crm_evidence` carries what the evidence IS (the CRM contact, GoHighLevel's source and id, which
-- date `occurred_at` is) plus the whose-win RULE's own answer and its input, so the rule's answer
-- can be restored exactly when a person withdraws their override, with no second call.
--
-- `lead_step_cause_statements` is a PERSON saying whose win a CRM-evidenced step was, overriding
-- the rule. Retractable, never deleted — the posture step statements and pairing rulings take.
--
-- Idempotent: a partially-applied state is a no-op.

ALTER TABLE "conversion_events" ALTER COLUMN "received_at" DROP NOT NULL;
ALTER TABLE "conversion_events" ADD COLUMN IF NOT EXISTS "crm_evidence" jsonb;

ALTER TABLE "lead_step_disqualifications" ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'manual';
ALTER TABLE "lead_step_disqualifications" ADD COLUMN IF NOT EXISTS "occurred_at" timestamp with time zone;
ALTER TABLE "lead_step_disqualifications" ADD COLUMN IF NOT EXISTS "crm_evidence" jsonb;
CREATE INDEX IF NOT EXISTS "idx_lsd_brand_source" ON "lead_step_disqualifications" ("brand_id", "source");

CREATE TABLE IF NOT EXISTS "lead_step_cause_statements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "lead_id" uuid NOT NULL REFERENCES "leads"("id") ON DELETE CASCADE,
  "step" text NOT NULL,
  "caused_by_outreach" boolean NOT NULL,
  "note" text,
  "stated_by_user_id" text,
  "withdrawn_at" timestamp with time zone,
  "withdrawn_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_lscs_brand_lead_step"
  ON "lead_step_cause_statements" ("brand_id", "lead_id", "step");
