-- 0070: a person who engages with one of our social posts (like, comment, repost, quote) is a lead of the
-- post's brand before we know any email (src/lib/social-identity.ts, src/lib/social-engagements.ts). Their
-- social identity is held as `lead_contact_methods` rows (channel `social` = social-service's person key,
-- `linkedin` = the vanity handle, `x` = the handle), unique per (channel, value) like an email.
-- This index lets an engager whose vanity handle is known find the lead we already hold for them (a served
-- lead carries `leads.linkedin_url` from the provider), so one person is never two leads.
-- Idempotent; nothing backfilled.
CREATE INDEX IF NOT EXISTS "idx_leads_linkedin_handle" ON "leads" ((substring(lower("linkedin_url") from 'linkedin\.com/in/([^/?#]+)')));
