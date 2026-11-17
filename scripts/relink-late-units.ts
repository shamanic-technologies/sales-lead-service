/**
 * ONE-TIME repair of late Units that consume a Unit the ledger does not hold (LATE-UNIT-LINK-1117).
 *
 * Why: until `resolveConsumption`, a fact of ours stated what it consumed from lead-service's evidence alone. Where no
 * service had produced that Unit (a positive reply only the CRM evidenced, a booking never declared, a `conversation`
 * on no evidence), runs-service links the late Unit to nothing: no source Unit, no campaign (prod 2026-11-17: 5 Units,
 * 2 meeting_booked, 1 meeting_attended, 2 paid_client).
 *
 * What: for every standing declaration of ours, the consumption the CURRENT rule picks (`resolveConsumption`, read off
 * the ledger at the Unit's own instant). Where it differs from what was declared, the consumption is corrected through
 * runs-service's own doors, never a database write there:
 *   1. scoped void of the run's consumed rows of the old key (`POST /v1/platform-runs/{id}/outcomes/void`,
 *      `scope: {direction: consumed, outcomeKey}`): the run stays open, its produced Units are untouched;
 *   2. every declaration of that run that consumed the old key is re-declared at its Unit's instant through the batch
 *      door (the produced Unit replays `already_recorded`): the corrected key for the Units repaired, the SAME key for
 *      their run mates (a scoped void takes back the run's consumed rows of the key, theirs included);
 *   3. `outcome_fact_declarations.consumed_outcome_key / consumed_basis` follow, once the whole run is re-declared.
 * A run whose re-declaration fails keeps its local rows: re-running redoes that run whole (both doors are idempotent).
 *
 * DRY RUN BY DEFAULT: prints the plan, writes nothing anywhere. `--apply` executes it (owner's go required).
 *
 * Run inside the lead-service container (its env, its node_modules):
 *   npx tsx scripts/relink-late-units.ts [--apply] [--org <orgId>]
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { RUNS_SERVICE_API_KEY, RUNS_SERVICE_URL } from "../src/config.js";
import { loadConsumptionEvidence, resolveConsumption } from "../src/lib/outcome-fact-declarations.js";
import { hasStandingProducedUnit } from "../src/lib/runs-client.js";
import { factOutcomeDeclaration, OUTCOME_SUBJECT_SERVICE, type FactOutcomeKey } from "../src/lib/run-outcomes.js";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const orgArg = args.includes("--org") ? args[args.indexOf("--org") + 1] : null;
const headers = { "content-type": "application/json", "x-api-key": RUNS_SERVICE_API_KEY, "x-service-name": OUTCOME_SUBJECT_SERVICE };

interface Row {
  org_id: string;
  brand_id: string;
  lead_id: string;
  outcome_key: FactOutcomeKey;
  run_id: string;
  consumed_outcome_key: string;
  consumed_basis: string | null;
}

/** The instant the ledger holds for the Unit (its produced occurrence on its run); null = not there, or reversed. */
async function unitInstant(r: Row): Promise<string | null> {
  const qs = new URLSearchParams({ runIds: r.run_id, subjectService: OUTCOME_SUBJECT_SERVICE, subjectIds: r.lead_id, direction: "produced", outcomeKey: r.outcome_key, limit: "10" });
  const res = await fetch(`${RUNS_SERVICE_URL}/internal/outcome-occurrences?${qs}`, { headers: { "X-API-Key": RUNS_SERVICE_API_KEY }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`ledger read ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { occurrences: Array<{ declaredAt: string; reversal: unknown }> };
  const standing = body.occurrences.filter((o) => !o.reversal);
  return standing.length === 1 ? standing[0].declaredAt : null;
}

const rows = (await db.execute(sql`
  SELECT org_id, brand_id, lead_id::text AS lead_id, outcome_key, run_id::text AS run_id, consumed_outcome_key, consumed_basis
  FROM outcome_fact_declarations
  WHERE caused_by_outreach AND reversed_at IS NULL AND consumed_outcome_key IS NOT NULL
    ${orgArg ? sql`AND org_id = ${orgArg}` : sql.empty()}
  ORDER BY org_id, run_id, lead_id
`)) as unknown as Row[];

interface Planned extends Row {
  occurredAt: string;
  next: { outcomeKey: string; basis: string };
}
const planned: Planned[] = [];
for (const r of rows) {
  const occurredAt = await unitInstant(r);
  if (!occurredAt) {
    console.log(`SKIP  org=${r.org_id} lead=${r.lead_id} ${r.outcome_key} run=${r.run_id}: no single standing Unit on the ledger`);
    continue;
  }
  // A declared consumption that stands is left alone, whatever the rule would pick today (later evidence never moves it).
  const endOfDay = new Date(Date.parse(`${occurredAt.slice(0, 10)}T00:00:00.000Z`) + 24 * 60 * 60_000).toISOString();
  if (await hasStandingProducedUnit(OUTCOME_SUBJECT_SERVICE, [r.lead_id], r.consumed_outcome_key, endOfDay)) {
    planned.push({ ...r, occurredAt, next: { outcomeKey: r.consumed_outcome_key, basis: r.consumed_basis ?? "" } });
    continue;
  }
  const f = { orgId: r.org_id, brandId: r.brand_id, leadId: r.lead_id, outcomeKey: r.outcome_key, conversionEventId: null, crmFactId: null, ours: true, source: "", toolName: null, at: occurredAt, occurredAt };
  const next = await resolveConsumption(f, await loadConsumptionEvidence(f));
  planned.push({ ...r, occurredAt, next });
}

// One group per (run, key taken back): the Units repaired there, and their run mates re-declared unchanged.
const groups = new Map<string, Planned[]>();
for (const p of planned.filter((x) => x.next.outcomeKey !== x.consumed_outcome_key)) groups.set(`${p.run_id}|${p.consumed_outcome_key}`, []);
for (const p of planned) groups.get(`${p.run_id}|${p.consumed_outcome_key}`)?.push(p);

console.log(`${rows.length} standing declarations of ours read, ${planned.length} on the ledger, ${[...groups.values()].flat().filter((p) => p.next.outcomeKey !== p.consumed_outcome_key).length} to repair on ${groups.size} run(s). ${apply ? "APPLYING." : "DRY RUN: nothing written."}`);

let failed = 0;
for (const [key, mates] of groups) {
  const [runId, oldKey] = key.split("|");
  console.log(`\nrun ${runId} (org ${mates[0].org_id}, brand ${mates[0].brand_id}): take back its ${mates.length} consumed ${oldKey}, re-declare:`);
  for (const p of mates) {
    const changed = p.next.outcomeKey !== oldKey;
    console.log(`  ${changed ? "REPAIR" : "same  "} lead=${p.lead_id} ${p.outcome_key} at ${p.occurredAt}: consumes ${oldKey}${changed ? ` -> ${p.next.outcomeKey} (${p.next.basis})` : ""}`);
  }
  if (!apply) continue;
  try {
    const voided = await fetch(`${RUNS_SERVICE_URL}/v1/platform-runs/${runId}/outcomes/void`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: `consumed ${oldKey} named a Unit nobody produced; re-declared on the Unit that stands`, voidedBy: "lead-service LATE-UNIT-LINK-1117", scope: { direction: "consumed", outcomeKey: oldKey } }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!voided.ok) throw new Error(`void ${voided.status} ${await voided.text()}`);
    console.log(`  void: ${await voided.text()}`);
    for (const p of mates) {
      const d = factOutcomeDeclaration({ orgId: p.org_id, runId, leadId: p.lead_id, outcomeKey: p.outcome_key, consumedOutcomeKey: p.next.outcomeKey, performer: null });
      const res = await fetch(`${RUNS_SERVICE_URL}/v1/platform-runs/outcomes/batch`, {
        method: "POST",
        headers,
        body: JSON.stringify({ runs: [{ runId, occurredAt: p.occurredAt, produced: d.produced, consumed: d.consumed }] }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`re-declare lead=${p.lead_id} ${res.status} ${await res.text()}`);
      console.log(`  re-declared lead=${p.lead_id}: ${await res.text()}`);
    }
    for (const p of mates.filter((x) => x.next.outcomeKey !== oldKey)) {
      await db.execute(sql`
        UPDATE outcome_fact_declarations SET consumed_outcome_key = ${p.next.outcomeKey}, consumed_basis = ${p.next.basis}
        WHERE org_id = ${p.org_id} AND brand_id = ${p.brand_id} AND lead_id = ${p.lead_id}::uuid AND outcome_key = ${p.outcome_key}
      `);
    }
  } catch (err) {
    failed++;
    console.error(`  FAILED (run again: this run is redone whole): ${err instanceof Error ? err.message : String(err)}`);
  }
}
if (failed > 0) process.exitCode = 1;
process.exit();
