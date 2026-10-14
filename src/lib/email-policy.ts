import { sql, type SQL } from "drizzle-orm";

/**
 * Which verified emails a serving workflow accepts (CATCHALL-SERVE-OPTION-1013, owner 2026-10-13).
 *
 * `valid_only` is the default and what a caller stating nothing gets: byte-identical to before the option existed.
 * `valid_and_catch_all` also accepts an address the verifier could not confirm because its domain accepts every
 * mailbox (~7% bounce measured, vs <1% for valid): a client whose market ran out of confirmed mailboxes keeps
 * reaching people. `valid_catch_all_and_unknown` (UNKNOWN-EMAILS-OPTION-1014, owner 2026-10-14) also accepts an address
 * the verifier could not judge at all (~15% bounce measured), chosen knowingly to keep a client's market spending.
 * invalid / risky are never accepted, whatever the option.
 *
 * lead-service applies nothing to a FRESH serve: human-service owns "deliverable" and gets the option on every serve
 * request. What lead-service owns is its own pools (retry, source stock, released): a person served under
 * `valid_and_catch_all` carries their address's verdict (`lead_contact_methods.verification_verdict`) and is never
 * handed from a pool to a campaign asking `valid_only`.
 */
export const EMAIL_POLICIES = ["valid_only", "valid_and_catch_all", "valid_catch_all_and_unknown"] as const;
export type EmailPolicy = (typeof EMAIL_POLICIES)[number];

export const DEFAULT_EMAIL_POLICY: EmailPolicy = "valid_only";

/**
 * What a POOL (retry, source stock, released) filters on: a pipe's stated policy, or `as_found` = hand the person as
 * the source found them. An outreach pipe serving a source's stock and stating nothing makes no email choice
 * (CATCHALL-SOURCE-OWNS-1014, owner 2026-10-14): which emails a source keeps is the SOURCE pipe's own strategy.
 */
export type PoolEmailPolicy = EmailPolicy | "as_found";

/** The verification verdicts a policy accepts. */
const ACCEPTED_VERDICTS: Record<EmailPolicy, readonly string[]> = {
  valid_only: ["valid"],
  valid_and_catch_all: ["valid", "catch_all"],
  valid_catch_all_and_unknown: ["valid", "catch_all", "unknown"],
};

export function acceptedVerdicts(policy: EmailPolicy | null | undefined): readonly string[] {
  return ACCEPTED_VERDICTS[policy ?? DEFAULT_EMAIL_POLICY];
}

/**
 * `AND NOT EXISTS (...)`: the lead carries no email whose recorded verdict the policy refuses (`as_found`: no clause). A NULL verdict (every
 * serve before the option, and serves with no verification: CRM, apify) is accepted, as it always was.
 */
export function emailPolicyClause(leadId: SQL, policy: PoolEmailPolicy | null | undefined): SQL {
  if (policy === "as_found") return sql``;
  const accepted = sql.join(acceptedVerdicts(policy).map((v) => sql`${v}`), sql`, `);
  return sql`AND NOT EXISTS (SELECT 1 FROM lead_contact_methods cm_v WHERE cm_v.lead_id = ${leadId} AND cm_v.channel = 'email' AND cm_v.verification_verdict IS NOT NULL AND cm_v.verification_verdict NOT IN (${accepted}))`;
}

/** A verdict as the producer stated it: a non-empty string, else null (no verification). */
export function readEmailVerdict(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error(`[lead-service] malformed email verdict from human-service: ${JSON.stringify(raw)}`);
  }
  return raw;
}
