-- ONE-AI-CONVERSES-1029-LEADFACTS: a product event the brand's server recorded in NO session (crm-act-types.ts
-- `isSessionlessProductEvent`: a newsletter-link identify, an org minted for an anonymous visitor) is not an act of the
-- person. The acts store kept 11,320 of them, each making a newsletter subscriber "acted toward us" (Lead follow-up due
-- served them); the next refreshActedAt pass re-derives last_action_at from the acts left. Idempotent.
DELETE FROM lead_crm_acts a
USING crm_facts f
WHERE f.fact_id = a.fact_id
  AND a.type = 'product_event'
  AND f.type = 'product_event' AND f.payload ? 'sessionId' AND f.payload->>'sessionId' IS NULL;
