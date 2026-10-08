-- instantly-service's outreach fact feed serves facts no org owns (1,199 of 193,664 on
-- 2026-10-08: early sends whose campaign was never linked, `orgId: null`, `brandIds: []`).
-- Bronze copies every fact verbatim, so the org is nullable; no brand read can reach them.
ALTER TABLE outreach_facts ALTER COLUMN org_id DROP NOT NULL;
