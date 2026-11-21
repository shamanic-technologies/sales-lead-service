-- BRAND-PROOF-LOGOS-1121 follow-up 3: a lookup states what it recorded. Version 2 attaches each role's LinkedIn company
-- page to its employer (brand-service's proof store refuses a company known by its name alone). Rows written before
-- are version 1: a career they found is read again once (client-past-employers-read.ts `LOOKUP_VERSION`).
ALTER TABLE client_history_lookups ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
