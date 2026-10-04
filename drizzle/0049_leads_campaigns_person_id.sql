-- Which human-service person this serve handed out: the id of the canonical person row
-- human-service resolves (or creates) when it serves someone from an audience (its
-- `people.id`, called `personId` on its own reads). The email stack records it as the
-- durable identity of the person it contacted, separately from lead_id (lead/provenance).
-- It lives on the lifecycle row because human-service people are scoped to an org and the
-- serve is the moment it was stated; a retried serve hands out the value stored here.
-- NULL = the serve carried none (every row before this, and any serve the producer did not
-- state a person for). Never backfilled, never derived from lead_id.
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "person_id" uuid;
