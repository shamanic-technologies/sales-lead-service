-- OUTCOME-FINEST-1106: a visit through one of our links is credited to the EXACT Unit the link names, whatever its
-- outcome (threads_post_published, newsletter_email_sent, ...), never a hard-coded post_published (src/lib/post-touch.ts).
-- `unit_outcome_key` = the outcome of the Unit the touch consumes: stated by the link (`dy_unit`), else read off the
-- ledger for a legacy `dy_post` link. NULL = not settled yet (the claim waits, asked again next pass).
ALTER TABLE post_touch_declarations ADD COLUMN IF NOT EXISTS unit_outcome_key text;
--> statement-breakpoint
-- Every touch already sent to runs-service consumed `post_published` (the only outcome the credit knew).
UPDATE post_touch_declarations SET unit_outcome_key = 'post_published' WHERE unit_outcome_key IS NULL AND status <> 'claimed';
--> statement-breakpoint
-- The dy_post-only partial index is replaced by `idx_crm_facts_unit_visits` (built after boot, read-model-search-index.ts).
DROP INDEX IF EXISTS idx_crm_facts_post_visits;
