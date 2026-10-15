-- 0091: tactic "Fresh contacts only" (FRESH-CONTACTS-1015, src/lib/recently-emailed.ts) asks, per served lead,
-- whether one of its addresses received an email of the brand inside the window. The copy is keyed on the address
-- only through (org_id, lead_email); the brand's sends are found by address whatever org stated them, so the
-- lookup needs the address first. Partial on sends: the other fact types are never asked this. ~200k rows on
-- 2026-10-08: a plain build takes about a second.
CREATE INDEX IF NOT EXISTS idx_outreach_facts_sent_email ON outreach_facts (lead_email, occurred_at) WHERE type = 'email_sent';
