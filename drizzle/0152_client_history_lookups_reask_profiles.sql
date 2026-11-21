-- BRAND-PROOF-LOGOS-1121 follow-up 2: the profile read asked ONE provider with the URL only. brightdata answered first
-- with `experience: null` (7 of 8 distribute.you payers on 2026-11-21) and harvestapi, which takes a handle, was never
-- reachable. The read now sends the handle too and re-asks a career-less answer without its provider: every stored
-- « no experience » is asked again.
DELETE FROM client_history_lookups WHERE status = 'no_experience';
-- v0.83.293 wrote the employer an enrich hit named; one provider answered a placeholder as the company name. That
-- fallback is removed; the one row it wrote (a lead's employment at an organization of that name, created by it) goes.
DELETE FROM leads_organizations lo USING organizations o
WHERE lo.organization_id = o.id AND lower(btrim(o.name)) = 'missing account name';
