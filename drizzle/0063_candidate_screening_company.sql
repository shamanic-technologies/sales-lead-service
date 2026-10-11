-- The company of each screened candidate, as human-service offered it (src/lib/candidate-serve.ts).
-- Lets a source campaign say which COMPANIES it found, rejected people included
-- (src/lib/source-people.ts). NULL on rows screened before this column existed: never backfilled.
ALTER TABLE candidate_screenings ADD COLUMN IF NOT EXISTS company_domain text;
ALTER TABLE candidate_screenings ADD COLUMN IF NOT EXISTS company_name text;
