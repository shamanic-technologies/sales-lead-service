-- GMAPS-SET-ASIDE-1127-REOPEN: a find set aside at handover because its audience COULD NOT judge the person (human-service
-- still-fits 422) is not a "no longer fits": it is judged again once the audience can answer (src/lib/source-stock-rejudge.ts).
-- The handover now stores human-service's code; rows set aside before it are recognised by human-service's own cannot-judge
-- sentences (every one its still-fits has ever answered), each mapped to its code. A real verdict keeps NULL and is never
-- re-opened. Additive, idempotent.
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "source_set_aside_cannot_judge" text;
--> statement-breakpoint
ALTER TABLE "leads_campaigns" ADD COLUMN IF NOT EXISTS "source_set_aside_rejudged_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "leads_campaigns"
   SET "source_set_aside_cannot_judge" = CASE "source_set_aside_reason"
         WHEN 'This audience never found this person, so it cannot say whether they still fit' THEN 'not_found_by_audience'
         WHEN 'This audience never found this business, so it cannot say whether it still fits' THEN 'not_found_by_audience'
         WHEN 'No person of this org holds this address, so this audience cannot say whether they still fit' THEN 'person_unknown'
         WHEN 'The brand''s CRM holds no person at this address, so this audience cannot say whether they still fit' THEN 'person_unknown_to_crm'
         WHEN 'A CRM audience judges a person by address; this find carries none' THEN 'email_required'
         WHEN 'A stepFilter can only be judged by the brand''s CRM; this is a search audience' THEN 'step_filter_needs_crm'
       END
 WHERE "source_set_aside_at" IS NOT NULL
   AND "source_handed_at" IS NULL
   AND "status_reason" = 'source_found'
   AND "source_set_aside_cannot_judge" IS NULL
   AND "source_set_aside_reason" IN (
     'This audience never found this person, so it cannot say whether they still fit',
     'This audience never found this business, so it cannot say whether it still fits',
     'No person of this org holds this address, so this audience cannot say whether they still fit',
     'The brand''s CRM holds no person at this address, so this audience cannot say whether they still fit',
     'A CRM audience judges a person by address; this find carries none',
     'A stepFilter can only be judged by the brand''s CRM; this is a search audience'
   );
