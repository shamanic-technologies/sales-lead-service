-- REPLY-LATENCY-ALL-CHANNELS-1019: "first message we sent -> first positive reply" (POST /internal/reply-latency/grouped)
-- reads the sends of the people who replied positively. Without it the read walks every send of the timeline (~170k rows).
CREATE INDEX IF NOT EXISTS "idx_ltf_sends_by_lead" ON "lead_timeline_facts" ("lead_id", "campaign_id", "occurred_at") WHERE "label" IN ('initial_email', 'followup') AND "withdrawn_at" IS NULL;
