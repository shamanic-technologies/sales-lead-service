-- LEDGER-DECLARE-1107 (owner 2026-11-07: « TOUS LES CHIFFRES DOIVENT ETRE ISSUS DE LA COMPTA INDUSTRIELLE »; « ON VEUT
-- LE TOTAL ET LES STATS PAR OUTCOME … INDEPENDAMMENT DES SOURCES »). Every lead outcome a brand's lead reaches is ONE Unit
-- on the ledger, whoever caused it. A Unit our outreach did NOT cause consumes nothing (none of our cost) and states its
-- attester as performer. A reach read off the CRM fact copy alone (no ledger row: the contact is not paired) names its
-- crm fact instead of a conversion event.
ALTER TABLE outcome_fact_declarations ALTER COLUMN conversion_event_id DROP NOT NULL;
ALTER TABLE outcome_fact_declarations ALTER COLUMN consumed_outcome_key DROP NOT NULL;
ALTER TABLE outcome_fact_declarations ALTER COLUMN consumed_basis DROP NOT NULL;
-- true = declared as OURS (consuming the outcome it came from). Every row before this migration was ours.
ALTER TABLE outcome_fact_declarations ADD COLUMN IF NOT EXISTS caused_by_outreach boolean NOT NULL DEFAULT true;
ALTER TABLE outcome_fact_declarations ADD COLUMN IF NOT EXISTS crm_fact_id text;
-- The instant the Unit was declared at (NULL = on time / before this migration).
ALTER TABLE outcome_fact_declarations ADD COLUMN IF NOT EXISTS occurred_at timestamptz;
-- runs-service refused turning a Unit declared as theirs into ours (kept, never resent).
ALTER TABLE outcome_fact_declarations ADD COLUMN IF NOT EXISTS cause_error text;
