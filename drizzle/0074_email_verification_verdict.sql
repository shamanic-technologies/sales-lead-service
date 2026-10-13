-- CATCHALL-SERVE-OPTION-1013 (2026-10-13): a serve can accept catch-all addresses when its workflow asks. The verdict
-- human-service hands with an address is recorded on it, so a pool (retry, source stock, released) never hands a
-- catch-all person to a campaign asking valid only (src/lib/email-policy.ts). NULL on every existing row: those were
-- all served valid only (or with no verification), and NULL is accepted by every policy. Nothing backfilled.
ALTER TABLE "lead_contact_methods" ADD COLUMN IF NOT EXISTS "verification_verdict" text;
