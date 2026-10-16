-- LEAD-FOLLOWUP-DATE-1016, owner correction 2026-10-16: "ce n'est pas qu'on a déjà échangé, mais au moins qu'ils ont
-- fait une action envers nous (website visit, quelque chose)"; "Il ne faut pas un Unibox vide de leurs actions." The
-- latest act of the person toward the brand read off crm-service's facts (a Unibox message on any channel, a visit, a
-- signup...). With the labelled timeline it is what "Lead follow-up due" reads: nobody with neither is ever served.
-- Our own sends never set it.
ALTER TABLE lead_followup_dates ADD COLUMN IF NOT EXISTS last_action_at timestamptz;
