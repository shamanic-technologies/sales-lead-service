-- The buying signal a served person's audience matched (the company is hiring, the person just
-- changed jobs, the company just raised), carried verbatim from human-service's served Person:
-- { type, occurredOn, fact, source, sourceUrl }. It is a fact about the SERVE (which audience
-- surfaced this person, and why), so it lives on the lifecycle row, not on `leads`: the same person
-- served to another campaign from an ordinary audience carries no signal there.
-- NULL = the serve carried none (every row before this, and every non-signal serve). Never
-- backfilled, never defaulted.
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "buying_signal" jsonb;
