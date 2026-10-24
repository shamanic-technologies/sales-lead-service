-- LEAD-IDENTIFIED-CONSUME-1024: a find from the client's CRM looks up the crm relation carrying the lead's email
-- (crm-lead-identified.ts, `emails && ...`), on every CRM serve and in the backfill. ~146k rows: a plain build is quick.
CREATE INDEX IF NOT EXISTS idx_crm_registry_facts_emails ON crm_registry_facts USING gin (emails);
