/**
 * Staff identity, byte-equal with the fleet staff lists (crm-service / client-service / billing-service
 * `isStaffEmail`, from api-service STAFF_EMAILS), plus any `@distribute.you` address. Plus-addressing is
 * ignored (`kevin.lourd+probe@gmail.com` is staff). The ONE definition in this service: the hot-lead door,
 * the conversion ingest and the not-a-person sweep all read it (FAKE-OUTCOMES-1022), never a name sniff.
 */
import { sql as drizzleSql, type SQL } from "drizzle-orm";

export const STAFF_EMAILS: readonly string[] = ["kevin.lourd@gmail.com", "kevin@distribute.you", "kevin@pressbeat.io"];
export const STAFF_DOMAIN = "@distribute.you";

export function isStaffEmail(email: string | null | undefined): boolean {
  const e = email?.trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  if (e.endsWith(STAFF_DOMAIN)) return true;
  const [local, domain] = e.split("@");
  return STAFF_EMAILS.includes(`${local.split("+")[0]}@${domain}`);
}

/**
 * The same predicate in SQL, over an address column (raw identifier, e.g. `cm.value`). Same answer as
 * `isStaffEmail` for every address (`tests/integration/not-a-person-sql.test.ts` checks both on one list).
 */
export function staffEmailSql(column: string): SQL {
  const v = drizzleSql.raw(`lower(btrim(${column}))`);
  return drizzleSql`(
    ${v} LIKE ${"%" + STAFF_DOMAIN}
    OR (split_part(split_part(${v}, '@', 1), '+', 1) || '@' || split_part(${v}, '@', 2)) = ANY(${drizzleSql.param([...STAFF_EMAILS])}::text[])
  )`;
}
