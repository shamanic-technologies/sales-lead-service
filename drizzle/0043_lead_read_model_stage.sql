-- Where on the funnel a `sales_interest` lead stands: the deepest funnel step known to have been
-- reached, or the funnel's entry step when only the entry was (see `salesInterestStage`,
-- src/lib/lead-standing.ts). A PARTITION of `sales_interest`, so a board can draw one column per
-- funnel step with sizes that add up. NULL for every other standing.
ALTER TABLE lead_read_model_rows ADD COLUMN IF NOT EXISTS stage text;
--> statement-breakpoint
-- Every model built before this column existed carries NULL for its sales_interest rows, which a
-- stage read must never count under a guessed stage. Retire them: a read rebuilds its scope, the
-- worker pre-builds every active brand's model on its first sweep, and a retired model is deleted
-- once no read can still hold it.
UPDATE lead_read_models SET scope_key = NULL, retired_at = now()
WHERE scope_key IS NOT NULL AND retired_at IS NULL;
