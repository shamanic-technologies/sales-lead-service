import { sql, type SQL } from "drizzle-orm";

/**
 * Which verified emails a serving workflow accepts (CATCHALL-SERVE-OPTION-1013, owner 2026-10-13).
 *
 * `valid_only` is the default and what a caller stating nothing gets: byte-identical to before the option existed.
 * `valid_and_catch_all` also accepts an address the verifier could not confirm because its domain accepts every
 * mailbox (~7% bounce measured, vs <1% for valid): a client whose market ran out of confirmed mailboxes keeps
 * reaching people. invalid / risky / unknown are never accepted, whatever the option.
 *
 * `valid_catch_all_and_unknown` (UNKNOWN-EMAILS-OPTION-1014, owner 2026-10-14) once also accepted an address the
 * verifier could not judge at all. SUPERSEDED on 2026-10-16 (CATCHALL-BOUNCE-1016): an address judged `unknown` is never
 * emailed (fleet 30 days: unknown bounced 36.8% vs catch_all 10.7%, valid 2.2%; campaign "Cold Follow-up Replies":
 * unknown 4 of 5 bounced, catch_all 0 of 5; cold-email deliverability consensus: LeadMagic, ZeroBounce, Instantly), and
 * the send door (instantly-service) refuses it, so a brand paying to find that person pays for nobody. The value is
 * still ACCEPTED on the wire so a live workflow stating it keeps working, and it behaves exactly as
 * `valid_and_catch_all` (`normalizeEmailPolicy`, applied once at the route edge, so it reaches human-service and every
 * pool as `valid_and_catch_all`).
 *
 * lead-service applies nothing to a FRESH serve: human-service owns "deliverable" and gets the option on every serve
 * request. What lead-service owns is its own pools (retry, source stock, released): a person served under
 * `valid_and_catch_all` carries their address's verdict (`lead_contact_methods.verification_verdict`) and is never
 * handed from a pool to a campaign asking `valid_only`.
 */
export const EMAIL_POLICIES = ["valid_only", "valid_and_catch_all"] as const;
export type EmailPolicy = (typeof EMAIL_POLICIES)[number];

/** DEPRECATED (CATCHALL-BOUNCE-1016): accepted on the wire, behaves as `valid_and_catch_all`. */
export const LEGACY_UNKNOWN_EMAIL_POLICY = "valid_catch_all_and_unknown" as const;

/** What the `acceptedEmails` body field accepts: the live policies plus the deprecated value. */
export const WIRE_EMAIL_POLICIES = [...EMAIL_POLICIES, LEGACY_UNKNOWN_EMAIL_POLICY] as const;
export type WireEmailPolicy = (typeof WIRE_EMAIL_POLICIES)[number];

export const DEFAULT_EMAIL_POLICY: EmailPolicy = "valid_only";

/** The caller's word as the policy it gets: the deprecated value is `valid_and_catch_all` (CATCHALL-BOUNCE-1016). */
export function normalizeEmailPolicy(raw: WireEmailPolicy): EmailPolicy;
export function normalizeEmailPolicy(raw: WireEmailPolicy | null | undefined): EmailPolicy | null;
export function normalizeEmailPolicy(raw: WireEmailPolicy | null | undefined): EmailPolicy | null {
  if (raw === undefined || raw === null) return null;
  return raw === LEGACY_UNKNOWN_EMAIL_POLICY ? "valid_and_catch_all" : raw;
}

/**
 * What a POOL (retry, source stock, released) filters on: a pipe's stated policy, or `as_found` = hand the person as
 * the source found them. An outreach pipe serving a source's stock and stating nothing makes no email choice
 * (CATCHALL-SOURCE-OWNS-1014, owner 2026-10-14): which emails a source keeps is the SOURCE pipe's own strategy. Even
 * `as_found` never hands out an address no pipe may email (`NEVER_SERVED_VERDICTS`, CATCHALL-BOUNCE-1016): a source
 * that kept an unknown person before 2026-10-16 holds a person nobody will write to.
 */
export type PoolEmailPolicy = EmailPolicy | "as_found";

/** The verification verdicts a policy accepts. */
const ACCEPTED_VERDICTS: Record<EmailPolicy, readonly string[]> = {
  valid_only: ["valid"],
  valid_and_catch_all: ["valid", "catch_all"],
};

/** Verdicts no policy accepts: the address is never emailed, so handing its person out only wastes. */
export const NEVER_SERVED_VERDICTS = ["unknown", "invalid", "risky"] as const;

export function acceptedVerdicts(policy: WireEmailPolicy | null | undefined): readonly string[] {
  return ACCEPTED_VERDICTS[normalizeEmailPolicy(policy) ?? DEFAULT_EMAIL_POLICY];
}

/**
 * `AND NOT EXISTS (...)`: the lead carries no email whose recorded verdict the policy refuses (`as_found`: only the
 * verdicts no policy accepts). A NULL verdict (every serve before the option, and serves with no verification: CRM,
 * apify) is accepted, as it always was.
 */
export function emailPolicyClause(leadId: SQL, policy: PoolEmailPolicy | WireEmailPolicy | null | undefined): SQL {
  if (policy === "as_found") {
    const refused = sql.join(NEVER_SERVED_VERDICTS.map((v) => sql`${v}`), sql`, `);
    return sql`AND NOT EXISTS (SELECT 1 FROM lead_contact_methods cm_v WHERE cm_v.lead_id = ${leadId} AND cm_v.channel = 'email' AND cm_v.verification_verdict IN (${refused}))`;
  }
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
