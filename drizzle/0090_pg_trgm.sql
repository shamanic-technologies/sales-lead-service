-- 0090: the trigram operator classes the Leads search index needs (DASH-LATENCY-1014).
--
-- Only the extension: it is instant and transactional. The index itself
-- (idx_lrmr_search_trgm, gin (search_text gin_trgm_ops) on lead_read_model_rows) is built AFTER boot,
-- CONCURRENTLY, by src/lib/read-model-search-index.ts on the background thread: a migration runs behind
-- the readiness gate inside a transaction, where CONCURRENTLY is refused and a plain build would lock the
-- read-model writers for the whole build. pg_trgm is a trusted extension (PG13+): the database owner may
-- create it.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
