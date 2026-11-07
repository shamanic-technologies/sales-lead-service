-- LEDGER-REVERSAL-1107: a Unit whose fact was taken back (every ledger row of the lead and outcome withdrawn: a person's
-- word, a staff test, a rejected pairing; or the CRM fact behind it withdrawn) is REVERSED at runs-service (a counter-entry
-- dated at the withdrawal, history kept). `reversed_at` = the reversal runs-service took; `reversal_error` = its refusal
-- (kept, never resent). A reversed row no longer holds the Unit: the fact coming back is declared again, on a new run.
ALTER TABLE outcome_fact_declarations ADD COLUMN IF NOT EXISTS reversed_at timestamptz;
ALTER TABLE outcome_fact_declarations ADD COLUMN IF NOT EXISTS reversal_error text;
