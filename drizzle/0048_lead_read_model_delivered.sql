-- Whether the email we sent a person was DELIVERED (contacted, no bounce at the model's scope; see
-- `isDelivered`, src/lib/lead-buckets.ts), so GET /orgs/leads/bucket-counts can state a delivered
-- PEOPLE count beside the contacted bucket.
ALTER TABLE lead_read_model_rows ADD COLUMN IF NOT EXISTS delivered boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Every model built before this column existed carries `false` for everyone, which would read as
-- "nobody delivered". Retire them: a read rebuilds its scope and the worker pre-builds every active
-- brand's model on its first sweep (same move as 0043).
UPDATE lead_read_models SET scope_key = NULL, retired_at = now()
WHERE scope_key IS NOT NULL AND retired_at IS NULL;
