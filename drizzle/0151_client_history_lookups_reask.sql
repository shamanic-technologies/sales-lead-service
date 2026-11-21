-- BRAND-PROOF-LOGOS-1121 follow-up: every « no LinkedIn » lookup stored so far was asked under the serve path's
-- $0.003 people.enrich ceiling, which reaches only the four cheapest email providers (2026-11-21, distribute.you:
-- 24 misses + 1 hit without a profile out of 25). The lookup now asks up to $0.06 a call, Apollo excluded: those
-- answers are not final. Deleted (no other table reads them) so the next call looks the clients up again.
DELETE FROM client_history_lookups WHERE status = 'no_linkedin';
