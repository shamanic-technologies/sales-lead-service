import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/**
 * The leads whose HUMAN carries a live opt_out / do_not_contact fact. A fact stated on a member that
 * a fleet merge folded into the lead's human is read through `human_aliases`.
 */
export async function loadHumanOptOuts(leadIds: readonly string[]): Promise<Set<string>> {
  if (leadIds.length === 0) return new Set();
  const rows = (await db.execute(sql`
    SELECT DISTINCT l.id::text AS lead_id
    FROM leads l
    JOIN (
      SELECT COALESCE(a.human_id, f.human_id) AS human_id
      FROM human_fact_copies f LEFT JOIN human_aliases a ON a.atomic_human_id = f.human_id
      WHERE f.withdrawn_at IS NULL AND f.kind IN ('opt_out', 'do_not_contact')
    ) h ON h.human_id = l.human_id
    WHERE l.id = ANY(${sql.param([...leadIds])}::uuid[])
  `)) as unknown as Array<{ lead_id: string }>;
  return new Set(rows.map((r) => r.lead_id));
}
