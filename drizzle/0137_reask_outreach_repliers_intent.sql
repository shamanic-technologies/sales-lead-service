-- UNIBOX-INTEREST-1102: Jev judged "wants business?" of a person who only answered our cold email on bare timeline
-- labels (`initial_email`, `question`), never the reply's verdict nor our answers in the thread (relationship-subjects.ts
-- `readThread` now carries both). Edmund Bartlett (Beyond Logic) wrote "I would like to learn more about your company
-- and what you can do for us" and read Unsure (0.42); 11 positive repliers of 191 read Unsure or Not interested. Every
-- judgment of a person whose thread holds a reply to our outreach is re-asked once by the sweep, on the new thread:
-- `thread_seq = -1` sits below any subject's own `thread_seq` (>= 0), the stale test `intentSubjectsToJudge` already
-- reads. Idempotent (a re-asked judgment writes the subject's real thread_seq back).
UPDATE relationship_intent_judgments i
SET thread_seq = -1
FROM relationship_subjects s
WHERE s.org_id = i.org_id AND s.brand_id = i.brand_id AND s.human_id = i.human_id AND s.company_key = i.company_key
  AND EXISTS (
    SELECT 1 FROM lead_timeline_facts f
    JOIN lead_contact_methods m ON m.lead_id = f.lead_id AND m.channel = 'email'
    WHERE f.org_id = s.org_id AND f.brand_id = s.brand_id AND f.source = 'reply' AND f.withdrawn_at IS NULL
      AND lower(m.value) = ANY (SELECT lower(e) FROM unnest(s.emails) e)
  );
