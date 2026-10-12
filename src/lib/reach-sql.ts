import { sql, type SQL } from "drizzle-orm";
import type { ReachMethod } from "./people-client.js";

/**
 * `AND EXISTS (...)` per contact method the serving pipe needs (src/lib/channel-reach.ts), on the lead the row names.
 * Email is always required (a served lead carries one: lead-service's served contract), so with no reach stated the
 * fragment is exactly the email check every pool already made. Methods are the stored `lead_contact_methods.channel`
 * words (`email`, `phone`).
 */
export function reachClauses(leadId: SQL, reachableBy: readonly ReachMethod[] | null | undefined): SQL {
  const methods = [...new Set<ReachMethod>(["email", ...(reachableBy ?? [])])].sort();
  return sql.join(
    methods.map(
      (m) => sql`AND EXISTS (SELECT 1 FROM lead_contact_methods cm_r WHERE cm_r.lead_id = ${leadId} AND cm_r.channel = ${m})`,
    ),
    sql` `,
  );
}
