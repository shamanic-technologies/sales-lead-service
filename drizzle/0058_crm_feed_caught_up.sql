-- The CRM evidence sync now reads its funnel facts off the bronze copy of crm-service's people fact
-- feed (crm_facts) instead of asking crm-service's funnel-events. The sync sets aside every CRM
-- outcome it no longer sees, so it must never read a copy that is still filling (a first pull, or
-- the re-pull after 0056): it would read a brand's meetings and sales as gone. `caught_up_at` is
-- written when a pull reaches the END of the feed (hasMore = false); the sync refuses to run
-- before it is set.
ALTER TABLE crm_feed_cursors ADD COLUMN IF NOT EXISTS caught_up_at timestamptz;
