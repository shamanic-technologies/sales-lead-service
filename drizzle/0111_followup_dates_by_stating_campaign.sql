-- NEXT-STEPS-ALL-CHANNELS-1019: "what has this campaign scheduled" reads the follow-up dates a campaign last stated
-- (GET /orgs/followup-dates/scheduled). Without it the read walks every row of the table (~360k, 1-2 s a call).
CREATE INDEX IF NOT EXISTS "idx_lfd_stated_by_campaign" ON "lead_followup_dates" ("org_id", "stated_by_campaign_id") WHERE "stated_by_campaign_id" IS NOT NULL;
