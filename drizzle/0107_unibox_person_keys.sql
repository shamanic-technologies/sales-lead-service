-- UNIBOX-SIX-TAGS-1017 follow-up: crm-service's person keys on each Unibox row, so the dashboard opens the person's
-- thread at crm-service (`/orgs/people/timeline?personKey=`) from a row lead-service serves.
ALTER TABLE "unibox_rows" ADD COLUMN IF NOT EXISTS "person_keys" text[] NOT NULL DEFAULT '{}';
