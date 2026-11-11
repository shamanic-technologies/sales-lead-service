-- MON-PAGE-SPEED-1111: a slow brand-wide read's last answer, served while it is valid (read-snapshots.ts).
CREATE TABLE IF NOT EXISTS "read_snapshots" (
  "kind" text NOT NULL,
  "org_id" text NOT NULL,
  "brand_id" text NOT NULL,
  "body" text NOT NULL,
  "built_at" timestamptz NOT NULL,
  "invalidated_at" timestamptz,
  PRIMARY KEY ("kind", "org_id", "brand_id")
);
--> statement-breakpoint
-- The steps a Unibox row reached, as an array an index can hold (`reachedStep=` filter, unibox-model.ts). Same set as
-- `EXISTS (SELECT 1 FROM jsonb_array_elements(steps) s WHERE s->>'step' = ANY(...))`; a non-array reads as none.
CREATE OR REPLACE FUNCTION unibox_reached_steps(steps jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(steps) = 'array'
    THEN ARRAY(SELECT s->>'step' FROM jsonb_array_elements(steps) s WHERE s->>'step' IS NOT NULL)
    ELSE '{}'::text[] END
$$;
