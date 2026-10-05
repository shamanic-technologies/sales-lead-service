-- PEOPLE sent at least one email, beside `delivered`, and `delivered` re-based on it: delivered
-- used to mean contacted-and-not-bounced, so every queued person nobody had emailed yet read as
-- delivered. Now delivered = sent AND not bounced (src/lib/lead-buckets.ts `isSent`/`isDelivered`).
ALTER TABLE lead_read_model_rows ADD COLUMN IF NOT EXISTS sent boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Every stored row carries the old `delivered` and `sent = false`. Retire every model: a read
-- rebuilds its scope and the worker pre-builds every active brand's model on its first sweep
-- (same move as 0043 and 0048).
UPDATE lead_read_models SET scope_key = NULL, retired_at = now()
WHERE scope_key IS NOT NULL AND retired_at IS NULL;
