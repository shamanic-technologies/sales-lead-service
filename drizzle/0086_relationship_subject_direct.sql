-- A lead of the brand known ONLY as a member / writer of a group chat shared with the brand's own people
-- (crm-service lists ~19k such "lurkers" for one brand) is not judged on its own: nothing in a group roster says
-- who they are to the brand, and a business-only pipe refuses an unjudged person anyway. `has_direct` = some fact
-- that is not a group fact (a DM, a signup, a payment, a CRM contact...). Merged into a known person, they are judged.
ALTER TABLE relationship_subjects ADD COLUMN IF NOT EXISTS has_direct boolean NOT NULL DEFAULT true;
