-- LEDGER-REVERSAL-1107 follow-up: the first reversal pass ran before runs-service served its reversal door and kept its
-- 404 as a refusal. A 404 is the door not being there yet: those Units are asked again.
UPDATE outcome_fact_declarations SET reversal_error = NULL WHERE reversed_at IS NULL AND reversal_error LIKE '404 %';
