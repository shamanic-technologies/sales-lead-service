-- HOT-INBOUND-UNANSWERED-1016 (owner 2026-10-16): "EVERY person who writes to us is TAGGED to know whether they are a
-- LEAD or not; and IF a lead, they are TAGGED on whether they WANT to do business with us or not." Whatever the
-- channel they came by. `wrote_to_us` / `last_inbound_at`: the person's own last act toward the brand (a message on any
-- mirrored channel, a signup, a form, a meeting, a payment, or a reply to our outreach). The second answer is Jev's
-- judgment of the whole thread, frozen per (org, brand, human) with the thread position it read.
ALTER TABLE relationship_subjects ADD COLUMN IF NOT EXISTS wrote_to_us boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE relationship_subjects ADD COLUMN IF NOT EXISTS last_inbound_at timestamptz;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS relationship_intent_judgments (
  org_id text NOT NULL,
  brand_id text NOT NULL,
  human_id uuid NOT NULL,
  p_wants_business double precision NOT NULL,
  thread_seq bigint NOT NULL,
  inbound_at timestamptz,
  model text NOT NULL,
  run_id text,
  judged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, brand_id, human_id)
);
