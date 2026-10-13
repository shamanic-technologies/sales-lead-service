/**
 * An opt-out observed HERE is stated on the HUMAN in human-service (owner 2026-10-13,
 * LEAD-REFONTE-1013: "never write to me again" follows the person to every company). Background
 * thread, every `HUMAN_OPT_OUTS_INTERVAL_MS`.
 *
 * Source: the labelled timeline (`lead_timeline_facts`), where the outreach provider's facts already
 * say it: `unsubscribed` (they clicked the link) and `opt_out` (they asked us to stop in a reply).
 * Each live one on a lead whose human is known is stated ONCE (`human_fact_statements`, keyed on the
 * timeline fact id) as `opt_out`, dated when they said it, naming the org it was said to. When the
 * timeline takes the fact back (the provider changed its verdict), the human fact is withdrawn too.
 * human-service down = nothing recorded, asked again next tick. The standing reads the copy back
 * (human-events.ts -> human_fact_copies), so a person's opt-out at one company shows at every other.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { HumanIdentityError, stateHumanFact, withdrawHumanFact } from "./human-identity-client.js";

export const HUMAN_OPT_OUTS_INTERVAL_MS = 5 * 60_000;
const BATCH = 200;
const FIRST_DELAY_MS = 120_000;
const OPT_OUT_LABELS = ["unsubscribed", "opt_out"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Pending {
  source_ref: string;
  human_id: string;
  org_id: string;
  label: string;
  occurred_at: Date | string | null;
}

export async function stateObservedOptOuts(): Promise<{ stated: number; withdrawn: number; failed: number }> {
  const pending = (await db.execute(sql`
    SELECT f.id AS source_ref, l.human_id::text AS human_id, f.org_id, f.label, f.occurred_at
    FROM lead_timeline_facts f
    JOIN leads l ON l.id = f.lead_id
    WHERE f.label = ANY(${sql.param(OPT_OUT_LABELS)}::text[]) AND f.withdrawn_at IS NULL AND l.human_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM human_fact_statements s WHERE s.source_ref = f.id)
    ORDER BY f.occurred_at NULLS LAST, f.id
    LIMIT ${BATCH}
  `)) as unknown as Pending[];
  let stated = 0;
  let failed = 0;
  for (const p of pending) {
    try {
      const at = p.occurred_at === null ? null : new Date(p.occurred_at);
      const r = await stateHumanFact(p.human_id, {
        kind: "opt_out",
        evidence: `${p.label === "opt_out" ? "asked to stop in a reply" : "unsubscribed from an email"} (lead-service timeline fact ${p.source_ref})`,
        statedByOrgId: UUID_RE.test(p.org_id) ? p.org_id : null,
        // human-service refuses a future instant; an undated fact is stated as now.
        statedAt: at && at.getTime() <= Date.now() ? at.toISOString() : null,
      });
      await db.execute(sql`
        INSERT INTO human_fact_statements (source_ref, human_id, kind, fact_id)
        VALUES (${p.source_ref}, ${p.human_id}::uuid, 'opt_out', ${r.fact.factId}::uuid)
        ON CONFLICT (source_ref) DO NOTHING
      `);
      stated++;
    } catch (err) {
      failed++;
      console.error(
        `[lead-service] human opt-outs: stating ${p.source_ref} on human ${p.human_id} failed` +
          `${err instanceof HumanIdentityError ? ` (${err.status})` : ""}: ${(err as Error).message}`,
      );
    }
  }

  const taken = (await db.execute(sql`
    SELECT s.source_ref, s.fact_id::text AS fact_id
    FROM human_fact_statements s
    LEFT JOIN lead_timeline_facts f ON f.id = s.source_ref
    WHERE s.withdrawn_at IS NULL AND s.fact_id IS NOT NULL AND (f.id IS NULL OR f.withdrawn_at IS NOT NULL)
    LIMIT ${BATCH}
  `)) as unknown as Array<{ source_ref: string; fact_id: string }>;
  let withdrawn = 0;
  for (const t of taken) {
    try {
      await withdrawHumanFact(t.fact_id, `lead-service timeline fact ${t.source_ref} was taken back`);
      await db.execute(sql`UPDATE human_fact_statements SET withdrawn_at = now() WHERE source_ref = ${t.source_ref}`);
      withdrawn++;
    } catch (err) {
      failed++;
      console.error(`[lead-service] human opt-outs: withdrawing fact ${t.fact_id} failed: ${(err as Error).message}`);
    }
  }
  return { stated, withdrawn, failed };
}

let running = false;

export function startHumanOptOutsWorker(): void {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await stateObservedOptOuts();
      if (r.stated + r.withdrawn + r.failed > 0) {
        console.log(`[lead-service] human opt-outs: stated=${r.stated} withdrawn=${r.withdrawn} failed=${r.failed}`);
      }
    } catch (err) {
      console.error("[lead-service] human opt-outs sweep failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), FIRST_DELAY_MS).unref();
  setInterval(() => void tick(), HUMAN_OPT_OUTS_INTERVAL_MS).unref();
}
