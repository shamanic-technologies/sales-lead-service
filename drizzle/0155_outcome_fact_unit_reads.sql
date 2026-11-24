-- ENGINE-GET-ASK-1123: Provider reads of the fact Units (GET /orgs/units/<fact outcome>, provider-units.ts).
-- outcome_fact_declarations is small (one row per org x brand x lead x outcome): plain indexes, idempotent.
-- A brand's Units of ONE outcome (the primary key starts org, brand, lead: the outcome is not a prefix).
CREATE INDEX IF NOT EXISTS "idx_ofd_org_outcome_brand" ON "outcome_fact_declarations" ("org_id", "outcome_key", "brand_id");
-- A person's Units across the org's brands (leadIds / emails / domains with no brandId).
CREATE INDEX IF NOT EXISTS "idx_ofd_lead" ON "outcome_fact_declarations" ("lead_id");
