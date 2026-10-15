/**
 * A person identified by PHONE (REPLY-PHONE-ONLY-1015): the canonical form both named-person doors
 * (`leads/by-email`, `followups/schedule-by-email`) key a phone-only person on.
 *
 * E.164 only, never a guess at a country: "+33 6 12-34.56(78)" -> "+33612345678", "0033..." -> "+33...",
 * a national number with no country code ("06 12 34 56 78") is refused (null). Stored phone contact
 * methods are compared through the same strip in SQL (`phoneValueSql`), so a stored "+33 6 12 34 56 78"
 * and the canonical form match exactly.
 */
import { sql, type SQL } from "drizzle-orm";

export const E164_RE = /^\+[1-9]\d{6,14}$/;

/** Separators a written phone may carry; stripped on both sides of every phone comparison. */
const SEPARATORS_RE = /[\s().\-/]/g;

export function canonicalE164(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let v = raw.trim().replace(SEPARATORS_RE, "");
  if (v.startsWith("00")) v = `+${v.slice(2)}`;
  return E164_RE.test(v) ? v : null;
}

/** A stored `lead_contact_methods.value` (or any phone column) in the canonical comparison form. */
export function phoneValueSql(column: SQL): SQL {
  return sql`regexp_replace(${column}, '[[:space:]()./-]', '', 'g')`;
}
