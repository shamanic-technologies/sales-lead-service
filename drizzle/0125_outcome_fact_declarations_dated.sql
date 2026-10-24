-- MEETING-DATED-OCCURRENCES-1024: every fact outcome is declared on the instant it HAPPENED (occurredAt). A declaration
-- made before that rule sits on the day it was declared (2026-10-23): `dated = false` until the sweep has moved it to
-- its fact's instant at runs-service (redate, the same occurrence). New declarations are written `dated = true`.
ALTER TABLE "outcome_fact_declarations" ADD COLUMN IF NOT EXISTS "dated" boolean NOT NULL DEFAULT false;
