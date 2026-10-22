-- BEST-TPL-LLM-1022-LS: a follow-up ledger `acted` row names the LLM alias the acting run wrote that message with,
-- as the run stated it (body `llmAlias` on the acted statement / acted-by-email). Workflows no longer fix their LLM
-- (features-service picks the leg's best LLM per send), so the workflow version no longer implies the model.
-- NULL = recorded before this column, or a run that stated none: served as unknown with a reason, never guessed.
ALTER TABLE "followup_actions" ADD COLUMN IF NOT EXISTS "llm_alias" text;
