-- BOX-LOAD-1028-LEAD-DAY. Two things, neither changes an answer.
--
-- 1. "Is this address / phone one of the brand's CRM facts?" (named-person.ts, followup-relationship-gate.ts,
--    step-reached-read.ts) matched `EXISTS (SELECT 1 FROM unnest(f.emails) e WHERE lower(trim(e)) = $x)`: nothing can
--    index that, so every ask walked every fact of the brand (116k on the largest: 8.5 s mean, 47k buffers a call, the
--    second lead_service statement at daytime). These functions state the same normalization once; the readers ask
--    `crm_fact_emails_norm(f.emails) @> ARRAY[$x]` (same rows: an element equal to $x after the same normalization),
--    and a GIN index on them is built after boot (read-model-search-index.ts LOAD_INDEXES, the table is ~420 MB).
CREATE OR REPLACE FUNCTION crm_fact_emails_norm(emails text[]) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT ARRAY(SELECT lower(btrim(e)) FROM unnest(emails) AS e) $$;
--> statement-breakpoint
-- Same normalization as e164-phone.ts `phoneValueSql`.
CREATE OR REPLACE FUNCTION crm_fact_phones_norm(phones text[]) RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT ARRAY(SELECT regexp_replace(p, '[[:space:]()./-]', '', 'g') FROM unnest(phones) AS p) $$;
--> statement-breakpoint
-- 2. Vacuum the big lookup tables often enough that their indexes answer alone. Under the default 20 % threshold
--    `organizations` (262k rows) waits for ~52k dead rows, and meanwhile most of its pages are not marked all-visible:
--    the identity sweep's idle employer check (an index-only scan of 180k never-resolved ids) fetched 107k heap rows
--    and took 5.6 s (16 s average under daytime load) on every tick, to find nothing. Settings only: no lock on
--    readers or writers, no row touched.
ALTER TABLE organizations SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
--> statement-breakpoint
ALTER TABLE leads SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
--> statement-breakpoint
ALTER TABLE leads_organizations SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_insert_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
--> statement-breakpoint
ALTER TABLE lead_delivery_evidence SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_insert_scale_factor = 0.05);
