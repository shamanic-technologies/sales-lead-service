-- SIGNALS-TITLE-AND-ROLE-1016: a suggested check carries a short card title and the AI's recommended role
-- (must_pass filter vs mention), with its reason. NULL on hand-made criteria and on suggestions written before.
ALTER TABLE "qualification_criteria" ADD COLUMN IF NOT EXISTS "title" text;
ALTER TABLE "qualification_criteria" ADD COLUMN IF NOT EXISTS "recommended_mode" text;
ALTER TABLE "qualification_criteria" ADD COLUMN IF NOT EXISTS "recommended_mode_reason" text;
