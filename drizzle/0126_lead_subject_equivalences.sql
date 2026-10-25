-- LEDGER-RESIDUAL-1025: lead-service owns the lead subject at runs-service's ledger; when two lead rows are the SAME
-- lead (our own identity records say so), we state it through runs-service's subject-equivalence door so one
-- occurrence declared under one id and consumed under the other counts once.
--
-- lead_identity_folds        a social engager lead folded into the lead an email found for the same person
--                            (social-identity.ts foldSocialLead): the folded row is usually DELETED, so this is the
--                            only trace that its id is that lead. No FK: the folded id no longer exists.
-- lead_subject_equivalences  what we stated at runs-service (immutable there, one hop): lead_id is the same subject
--                            as target_lead_id. No FK: a statement outlives a deleted row. `refused` = runs-service
--                            refused it (reason kept), never re-sent blindly.
CREATE TABLE IF NOT EXISTS lead_identity_folds (
  from_lead_id uuid PRIMARY KEY,
  into_lead_id uuid NOT NULL,
  folded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS lead_subject_equivalences (
  lead_id uuid PRIMARY KEY,
  target_lead_id uuid NOT NULL,
  bases text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('stated', 'refused')),
  refused_reason text,
  stated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_lse_target ON lead_subject_equivalences (target_lead_id);
