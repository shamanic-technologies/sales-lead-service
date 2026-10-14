-- "Who reached step S at brand B since T" (GET /internal/brands/{brandId}/step-reached, FACT-NOT-FOLLOWED-1014) reads
-- the brand's live facts of a few types in a time window every 5 minutes per brand x offer; without this the planner
-- seq-scans the whole copy (~230ms on 105k rows, 2026-10-14).
CREATE INDEX IF NOT EXISTS idx_crm_facts_brand_type_at ON crm_facts (org_id, brand_id, type, occurred_at);
