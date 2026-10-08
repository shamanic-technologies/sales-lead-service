-- crm-service added `crmContactId` (its own contact row id, the key every CRM pairing here is
-- frozen on) to every people fact, and BACKFILLED it into facts it had already emitted
-- (crm-service#64). The bronze copy took those facts before the field existed, and it is
-- append-only: a fact already copied is never re-read. So the copy is emptied and its cursor
-- dropped, and the next pull copies the whole feed again from the start, verbatim, with the id.
-- Nothing reads `crm_facts` yet, so an empty copy for one pull interval hides nothing.
ALTER TABLE crm_facts ADD COLUMN IF NOT EXISTS crm_contact_id text;
DELETE FROM crm_facts WHERE crm_contact_id IS NULL AND NOT (raw ? 'crmContactId');
DELETE FROM crm_feed_cursors WHERE feed = 'people_facts';
CREATE INDEX IF NOT EXISTS idx_crm_facts_brand_crm_contact ON crm_facts (org_id, brand_id, crm_contact_id);
