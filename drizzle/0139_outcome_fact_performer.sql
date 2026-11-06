-- LEAD-GENERIC-1106 (owner 2026-11-06: « la provenance est clé pour les stats, mais doit être stockée de façon
-- généralisée, par outcome »). Every outcome occurrence lead-service declares on a recording run states WHO performed it
-- (runs-service v0.47.133 `performer`). `performer` = what we stated (NULL = not stated yet: the occurrences declared
-- before this, completed once by the performer pass); `performer_error` = runs-service refused it (kept, never resent).
ALTER TABLE outcome_fact_declarations ADD COLUMN IF NOT EXISTS performer jsonb;
ALTER TABLE outcome_fact_declarations ADD COLUMN IF NOT EXISTS performer_error text;
