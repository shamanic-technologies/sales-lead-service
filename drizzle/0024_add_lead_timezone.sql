-- 0024: Add leads.timezone (recipient IANA timezone).
--
-- Carries the recipient's IANA timezone (e.g. "America/New_York") from upstream
-- (human-service, originally apollo-service) onto the canonical lead, so the send
-- chain (email-gateway-service → instantly-service) can schedule cold email in
-- the recipient's local business hours. Nullable + backward-compatible: absent
-- timezone is tolerated and downstream falls back to a safe default.
--
-- Guarded so a partially-applied state is a no-op.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "timezone" text;
