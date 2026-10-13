import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/** What human-service carries on a lead's HUMAN (wherever they work), as served on lead rows. */
export interface LeadHumanBlock {
  /** A live `opt_out` fact: they said never write to me again. */
  optedOut: boolean;
  /** A live `do_not_contact` fact (e.g. a CRM's DND). */
  doNotContact: boolean;
}

/**
 * The human-level facts of these leads' humans, keyed by lead id; a lead absent from the map has
 * none (or no known human). A fact stated on a member that a fleet merge folded into the lead's
 * human is read through `human_aliases`.
 */
export async function loadHumanFacts(leadIds: readonly string[]): Promise<Map<string, LeadHumanBlock>> {
  const out = new Map<string, LeadHumanBlock>();
  if (leadIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT l.id::text AS lead_id,
      bool_or(h.kind = 'opt_out') AS opted_out,
      bool_or(h.kind = 'do_not_contact') AS do_not_contact
    FROM leads l
    JOIN (
      SELECT COALESCE(a.human_id, f.human_id) AS human_id, f.kind
      FROM human_fact_copies f LEFT JOIN human_aliases a ON a.atomic_human_id = f.human_id
      WHERE f.withdrawn_at IS NULL AND f.kind IN ('opt_out', 'do_not_contact')
    ) h ON h.human_id = l.human_id
    WHERE l.id = ANY(${sql.param([...leadIds])}::uuid[])
    GROUP BY l.id
  `)) as unknown as Array<{ lead_id: string; opted_out: boolean; do_not_contact: boolean }>;
  for (const r of rows) out.set(r.lead_id, { optedOut: r.opted_out, doNotContact: r.do_not_contact });
  return out;
}

/** The leads whose HUMAN carries a live opt_out / do_not_contact fact. */
export async function loadHumanOptOuts(leadIds: readonly string[]): Promise<Set<string>> {
  return new Set((await loadHumanFacts(leadIds)).keys());
}
