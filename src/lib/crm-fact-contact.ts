import { sql, type SQL } from "drizzle-orm";

/**
 * "Does this CRM fact name this address / phone?" as an INDEXED predicate (BOX-LOAD-1028-LEAD-DAY).
 *
 * Same rows as `EXISTS (SELECT 1 FROM unnest(<f>.emails) e WHERE lower(trim(e)) = <email>)` (and the phone twin with
 * e164-phone.ts `phoneValueSql`): migration 0131's `crm_fact_emails_norm` / `crm_fact_phones_norm` apply exactly that
 * normalization to every element, and `@>` holds when one of them equals the value. The unnest form could not use an
 * index, so each ask walked every fact of the brand; the function form is what the post-boot GIN indexes
 * (`idx_crm_facts_emails_norm` / `_phones_norm`) cover. The value is compared as given: callers pass it already
 * normalized, as they did before.
 */
export function crmFactHasEmail(alias: string, email: string): SQL {
  return sql`crm_fact_emails_norm(${sql.raw(alias)}.emails) @> ARRAY[${email}::text]`;
}

export function crmFactHasPhone(alias: string, phone: string): SQL {
  return sql`crm_fact_phones_norm(${sql.raw(alias)}.phones) @> ARRAY[${phone}::text]`;
}
