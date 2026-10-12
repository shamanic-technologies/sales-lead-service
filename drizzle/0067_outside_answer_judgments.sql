-- "Did our email answer them?" (owner 2026-10-12: "Needs your call" clears BY ITSELF when one of
-- our people answers a prospect from their own Gmail). For a person waiting on us, every later
-- email one of our people sent them out of a mailbox google-service mirrors (the org's own
-- mailboxes, and staff mailboxes for any client brand) is judged ONCE by Jev: does it answer what
-- they wrote, or is it about something unrelated? The verdict is frozen here with the model
-- release; src/lib/awaiting-reply-read.ts reads a `answers = true` row as an answer of ours dated
-- `sent_at`. A row with `answers = false` is kept so the same email is never judged twice.
CREATE TABLE IF NOT EXISTS outside_answer_judgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id text NOT NULL,
  brand_id text NOT NULL,
  lead_id uuid NOT NULL,
  gmail_message_id text NOT NULL,
  -- Which mirror held it: 'org' (the org's own mailboxes) or 'staff' (a staff mailbox).
  mailbox text NOT NULL,
  from_email text,
  sent_at timestamptz NOT NULL,
  subject text,
  -- The person's latest message the email was judged against (outreach fact subject key).
  inbound_ref text,
  answers boolean NOT NULL,
  probability double precision NOT NULL,
  model text NOT NULL,
  judged_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_outside_answer_judgments_message
  ON outside_answer_judgments (org_id, brand_id, lead_id, gmail_message_id);
