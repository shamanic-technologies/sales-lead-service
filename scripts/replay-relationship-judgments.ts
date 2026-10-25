/**
 * STAFF REPLAY (JEV-WEAK-EVIDENCE-1025): asks Jev again, with the CURRENT judge (questions + thread rendering), about
 * the people of one brand whose stored judgment says "not a lead" (prospect and customer under the no edge), and
 * prints before/after per person. Writes NOTHING (askSubject, never judgeSubject): the live sweep re-judges them on
 * its own once the judge version moved.
 *
 * Run inside the lead-service container (its env, its node_modules), from the compiled dist:
 *   node dist/../scripts-dist/replay-relationship-judgments.js <orgId> <brandId> [limit]
 * Platform-billed through chat-service, on ONE staff run (staff_experiment).
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { createRun } from "../src/lib/runs-client.js";
import { askSubject } from "../src/lib/relationship-judge.js";
import { toSubject } from "../src/lib/relationship-subjects.js";
import { JUDGED_NO, judgedState } from "../src/lib/relationship-tags.js";

const [orgId, brandId, limitArg] = process.argv.slice(2);
if (!orgId || !brandId) throw new Error("usage: replay-relationship-judgments <orgId> <brandId> [limit]");
const limit = Number(limitArg ?? 200);

const rows = (await db.execute(sql`
  SELECT s.*, j.probabilities AS old_probabilities,
    EXISTS (SELECT 1 FROM crm_facts f WHERE f.org_id = s.org_id AND f.brand_id = s.brand_id AND f.contact_point = ANY(s.contact_points)
      AND f.type IN ('message_in', 'website_visit', 'product_event', 'signup', 'form_submitted', 'meeting_booked', 'payment', 'sale')
      AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = f.fact_id)) AS acted
  FROM relationship_subjects s
  JOIN relationship_judgments j USING (org_id, brand_id, human_id, company_key)
  WHERE s.org_id = ${orgId} AND s.brand_id = ${brandId} AND s.has_direct
    AND (j.probabilities->>'prospect')::float8 < ${JUDGED_NO} AND (j.probabilities->>'customer')::float8 < ${JUDGED_NO}
  ORDER BY s.thread_seq DESC
  LIMIT ${limit}
`)) as unknown as Array<Record<string, unknown>>;

const run = await createRun({
  orgId,
  brandId,
  serviceName: "lead-service",
  taskName: "relationship-judgment-replay",
  support: { kind: "staff_experiment", reason: "Staff replay of relationship judgments under a new judge version; writes nothing (JEV-WEAK-EVIDENCE-1025)." },
});

const leadOf = (p: Record<string, number>) => {
  const best = Math.max(p.prospect ?? 0, p.customer ?? 0);
  return judgedState(best);
};
const fmt = (p: Record<string, number>) => {
  const other = Object.entries(p).filter(([k]) => !["prospect", "customer", "personal"].includes(k)).sort((a, b) => b[1] - a[1])[0];
  return `prospect ${p.prospect?.toFixed(2)} customer ${p.customer?.toFixed(2)} top-other ${other ? `${other[0]} ${other[1].toFixed(2)}` : "-"} -> lead ${leadOf(p)}`;
};

const tally: Record<string, number> = {};
for (const r of rows) {
  const s = toSubject(r);
  const before = r.old_probabilities as Record<string, number>;
  try {
    const { probabilities } = await askSubject(s, run.id);
    const after = probabilities as unknown as Record<string, number>;
    const key = `${r.acted ? "acted" : "no_act"}: ${leadOf(before)} -> ${leadOf(after)}`;
    tally[key] = (tally[key] ?? 0) + 1;
    console.log(`${s.name ?? "?"} <${s.emails[0] ?? ""}> acted=${r.acted}\n  before: ${fmt(before)}\n  after:  ${fmt(after)}`);
  } catch (err) {
    tally.failed = (tally.failed ?? 0) + 1;
    console.error(`${s.name ?? "?"}: replay failed`, err);
  }
}
console.log(`\nrun ${run.id}, ${rows.length} people`);
console.log(JSON.stringify(tally, null, 2));
process.exit(0);
