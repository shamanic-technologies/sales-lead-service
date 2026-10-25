/**
 * WHICH LEAD ROWS ARE THE SAME LEAD, stated at runs-service's ledger (LEDGER-RESIDUAL-1025; doctrine: agent-config
 * `cost-accounting`). A person's occurrences name their lead id here; when two of our lead rows are one lead, an
 * occurrence produced under one and consumed under the other would count twice and its consumption trace to nobody.
 * lead-service owns the lead subject, so it alone states "lead X is the same subject as lead Y" through runs-service
 * `POST /v1/platform-runs/subject-equivalences` (one hop, immutable, all or nothing per call).
 *
 * Only OUR OWN identity records say two rows are one lead, never a provider's word:
 *   - `served_row_repaired`: `leads_campaigns.repointed_from_lead_id` (repair-served-lead-emails.ts moved a served row
 *     from the lead that could not hold the served email to the lead owning it: that lead IS the person);
 *   - `recorded_duplicate`: `lead_identity_duplicates` (two leads of ONE human, human-service's answer, at ONE company);
 *     a human holding two leads at one company that no merge event recorded ("found twice": the identity sweep
 *     resolved both to the same human) is recorded first, same rule as a merge (oldest survives);
 *   - `social_fold`: `lead_identity_folds` (a social engager folded into the lead an email found, social-identity.ts).
 * Two leads human-service calls two humans stay two subjects here, whatever a provider says about them.
 *
 * Every connected group gets ONE target: the lead already stated as a target in it, else its OLDEST living lead
 * (created_at, id; the same "oldest survives" rule as the duplicates). Every other lead of the group is stated once.
 * A group holding two stated targets, or no living lead, is skipped with its reason (logged), never guessed.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { fetchWithRetry } from "./fetch-retry.js";

const RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "http://localhost:3006";
const RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "";
export const SUBJECT_SERVICE = "lead-service";
export const EQUIVALENCE_BATCH = 1000;

export type EquivalenceBasis = "served_row_repaired" | "recorded_duplicate" | "social_fold";

export interface IdentityEdge {
  fromLeadId: string;
  toLeadId: string;
  basis: EquivalenceBasis;
}

export interface LivingLead {
  createdAt: string;
}

export interface StatedRow {
  targetLeadId: string;
  status: "stated" | "refused";
}

export interface PlannedEquivalence {
  leadId: string;
  targetLeadId: string;
  bases: EquivalenceBasis[];
}

export type SkipReason = "several_stated_targets" | "no_living_lead";

export interface EquivalencePlan {
  groups: number;
  items: PlannedEquivalence[];
  alreadyStated: number;
  skipped: Array<{ leadIds: string[]; reason: SkipReason }>;
}

/**
 * Pure: the statements still owed, off our identity edges, the leads that exist (with their creation instant) and
 * what was already stated (or refused) at runs-service.
 */
export function planEquivalences(
  edges: readonly IdentityEdge[],
  living: ReadonlyMap<string, LivingLead>,
  stated: ReadonlyMap<string, StatedRow>,
): EquivalencePlan {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  const union = (a: string, b: string) => {
    add(a);
    add(b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const bases = new Map<string, Set<EquivalenceBasis>>();
  const noteBasis = (x: string, b: EquivalenceBasis) => (bases.get(x) ?? bases.set(x, new Set()).get(x)!).add(b);
  for (const e of edges) {
    if (e.fromLeadId === e.toLeadId) continue;
    union(e.fromLeadId, e.toLeadId);
    noteBasis(e.fromLeadId, e.basis);
    noteBasis(e.toLeadId, e.basis);
  }
  // Earlier statements bind the group: a stated pair is part of it whatever the edges say today.
  for (const [leadId, row] of stated) {
    if (row.status !== "stated") continue;
    if (parent.has(leadId) || parent.has(row.targetLeadId)) union(leadId, row.targetLeadId);
  }

  const groups = new Map<string, string[]>();
  for (const x of parent.keys()) {
    const r = find(x);
    (groups.get(r) ?? groups.set(r, []).get(r)!).push(x);
  }

  const statedTargets = new Set([...stated.values()].filter((s) => s.status === "stated").map((s) => s.targetLeadId));
  const items: PlannedEquivalence[] = [];
  const skipped: EquivalencePlan["skipped"] = [];
  let alreadyStated = 0;
  for (const members of groups.values()) {
    members.sort();
    const targets = members.filter((m) => statedTargets.has(m));
    let target: string | null;
    if (targets.length > 1) {
      skipped.push({ leadIds: members, reason: "several_stated_targets" });
      continue;
    } else if (targets.length === 1) {
      target = targets[0];
    } else {
      const alive = members.filter((m) => living.has(m));
      if (alive.length === 0) {
        skipped.push({ leadIds: members, reason: "no_living_lead" });
        continue;
      }
      alive.sort((a, b) => {
        const ca = living.get(a)!.createdAt;
        const cb = living.get(b)!.createdAt;
        return ca < cb ? -1 : ca > cb ? 1 : a < b ? -1 : a > b ? 1 : 0;
      });
      target = alive[0];
    }
    for (const m of members) {
      if (m === target) continue;
      if (stated.has(m)) {
        alreadyStated++;
        continue;
      }
      items.push({ leadId: m, targetLeadId: target, bases: [...(bases.get(m) ?? bases.get(target) ?? [])].sort() });
    }
  }
  items.sort((a, b) => (a.leadId < b.leadId ? -1 : 1));
  return { groups: groups.size, items, alreadyStated, skipped };
}

// ─── IO ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** "Found twice": a human holding several leads at one company that no merge event recorded (oldest survives). */
const FOUND_TWICE_SQL = sql`
  SELECT id, survivor, human_id, company_id FROM (
    SELECT id, human_id, company_id,
      first_value(id) OVER (PARTITION BY human_id, company_id ORDER BY created_at, id) AS survivor
    FROM leads WHERE human_id IS NOT NULL AND company_id IS NOT NULL
      AND (human_id, company_id) IN (
        SELECT human_id, company_id FROM leads WHERE human_id IS NOT NULL AND company_id IS NOT NULL
        GROUP BY 1, 2 HAVING count(*) > 1)
  ) r
  WHERE id <> survivor AND NOT EXISTS (SELECT 1 FROM lead_identity_duplicates d WHERE d.lead_id = r.id)
`;

/** Records every found-twice duplicate (never overwrites a merge's row). Returns how many were recorded. */
export async function recordFoundTwiceDuplicates(): Promise<number> {
  const rows = (await db.execute(sql`
    INSERT INTO lead_identity_duplicates (lead_id, survivor_lead_id, human_id, company_id, reason)
    SELECT id, survivor, human_id, company_id, 'found_twice' FROM (${FOUND_TWICE_SQL}) f
    ON CONFLICT (lead_id) DO NOTHING
    RETURNING lead_id
  `)) as unknown as unknown[];
  return rows.length;
}

/** Every identity edge our records hold (plus, on a dry run, the found-twice duplicates not recorded yet). */
export async function loadIdentityEdges(includeUnrecordedFoundTwice: boolean): Promise<IdentityEdge[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT repointed_from_lead_id::text AS from_id, lead_id::text AS to_id, 'served_row_repaired' AS basis
      FROM leads_campaigns WHERE repointed_from_lead_id IS NOT NULL
    UNION ALL
    SELECT lead_id::text, survivor_lead_id::text, 'recorded_duplicate' FROM lead_identity_duplicates
    UNION ALL
    SELECT from_lead_id::text, into_lead_id::text, 'social_fold' FROM lead_identity_folds
    ${includeUnrecordedFoundTwice ? sql`UNION ALL SELECT id::text, survivor::text, 'recorded_duplicate' FROM (${FOUND_TWICE_SQL}) f` : sql.empty()}
  `)) as unknown as Array<{ from_id: string; to_id: string; basis: EquivalenceBasis }>;
  return rows.map((r) => ({ fromLeadId: r.from_id, toLeadId: r.to_id, basis: r.basis }));
}

async function loadLiving(ids: string[]): Promise<Map<string, LivingLead>> {
  if (ids.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT id::text AS id, created_at::text AS created_at FROM leads WHERE id = ANY(${sql.param(ids)}::uuid[])
  `)) as unknown as Array<{ id: string; created_at: string }>;
  // created_at::text is a fixed-width UTC-offset timestamp string in one session: byte order = time order.
  return new Map(rows.map((r) => [r.id, { createdAt: r.created_at }]));
}

async function loadStated(): Promise<Map<string, StatedRow>> {
  const rows = (await db.execute(sql`
    SELECT lead_id::text AS lead_id, target_lead_id::text AS target, status FROM lead_subject_equivalences
  `)) as unknown as Array<{ lead_id: string; target: string; status: "stated" | "refused" }>;
  return new Map(rows.map((r) => [r.lead_id, { targetLeadId: r.target, status: r.status }]));
}

export type EquivalencePost = (body: unknown) => Promise<{ status: number; text: string }>;

const postEquivalences: EquivalencePost = async (body) => {
  const res = await fetchWithRetry(`${RUNS_SERVICE_URL}/v1/platform-runs/subject-equivalences`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": RUNS_SERVICE_API_KEY, "x-service-name": SUBJECT_SERVICE },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, text: await res.text() };
};

async function recordRows(items: PlannedEquivalence[], status: "stated" | "refused", reasons?: Map<string, string>): Promise<void> {
  if (items.length === 0) return;
  const json = JSON.stringify(
    items.map((i) => ({ lead_id: i.leadId, target: i.targetLeadId, bases: i.bases, reason: reasons?.get(i.leadId) ?? null })),
  );
  await db.execute(sql`
    INSERT INTO lead_subject_equivalences (lead_id, target_lead_id, bases, status, refused_reason)
    SELECT (x->>'lead_id')::uuid, (x->>'target')::uuid, ARRAY(SELECT jsonb_array_elements_text(x->'bases')),
      ${status}, x->>'reason'
    FROM jsonb_array_elements(${json}::jsonb) x
    ON CONFLICT (lead_id) DO NOTHING
  `);
}

export interface EquivalenceSummary {
  dryRun: boolean;
  duplicatesRecorded: number;
  edges: number;
  groups: number;
  alreadyStated: number;
  planned: number;
  recorded: number;
  alreadyRecorded: number;
  refused: Array<{ leadId: string; targetLeadId: string; reason: string }>;
  skipped: Array<{ leadIds: string[]; reason: SkipReason }>;
}

/**
 * One pass: record found-twice duplicates, plan, state what is owed (batches of 1000). A 422 names the refused
 * items: they are kept `refused` with runs-service's reason (logged), the rest of the batch is sent again. Any other
 * failure stops the pass (asked again next pass). A replay states nothing new.
 */
export async function stateLeadSubjectEquivalences(
  opts: { dryRun: boolean },
  post: EquivalencePost = postEquivalences,
): Promise<EquivalenceSummary> {
  const duplicatesRecorded = opts.dryRun ? 0 : await recordFoundTwiceDuplicates();
  const edges = await loadIdentityEdges(opts.dryRun);
  const ids = [...new Set(edges.flatMap((e) => [e.fromLeadId, e.toLeadId]))];
  const [living, stated] = await Promise.all([loadLiving(ids), loadStated()]);
  const plan = planEquivalences(edges, living, stated);
  const summary: EquivalenceSummary = {
    dryRun: opts.dryRun,
    duplicatesRecorded,
    edges: edges.length,
    groups: plan.groups,
    alreadyStated: plan.alreadyStated,
    planned: plan.items.length,
    recorded: 0,
    alreadyRecorded: 0,
    refused: [],
    skipped: plan.skipped,
  };
  for (const s of plan.skipped) console.error(`[lead-service] subject equivalences: group ${s.leadIds.join(",")} skipped (${s.reason})`);
  if (opts.dryRun) return summary;

  for (let i = 0; i < plan.items.length; i += EQUIVALENCE_BATCH) {
    let batch = plan.items.slice(i, i + EQUIVALENCE_BATCH);
    for (let attempt = 0; attempt < 2 && batch.length > 0; attempt++) {
      const res = await post({
        items: batch.map((b) => ({ subjectService: SUBJECT_SERVICE, subjectId: b.leadId, targetService: SUBJECT_SERVICE, targetId: b.targetLeadId })),
        reason: "LEDGER-RESIDUAL-1025: the same lead per lead-service's own identity records (repaired served row, recorded duplicate of one human at one company, folded social engager)",
        statedBy: SUBJECT_SERVICE,
      });
      if (res.status === 200) {
        const body = JSON.parse(res.text) as { recordedCount: number; alreadyRecordedCount: number };
        summary.recorded += body.recordedCount;
        summary.alreadyRecorded += body.alreadyRecordedCount;
        await recordRows(batch, "stated");
        batch = [];
        break;
      }
      if (res.status === 422) {
        const refusals = (JSON.parse(res.text) as { details?: { refusals?: Array<{ index: number; reason: string }> } }).details?.refusals ?? [];
        if (refusals.length === 0) throw new Error(`runs-service refused subject equivalences without naming them: ${res.text}`);
        const reasons = new Map<string, string>();
        for (const r of refusals) if (batch[r.index]) reasons.set(batch[r.index].leadId, r.reason);
        const refused = batch.filter((b) => reasons.has(b.leadId));
        await recordRows(refused, "refused", reasons);
        for (const b of refused) {
          summary.refused.push({ leadId: b.leadId, targetLeadId: b.targetLeadId, reason: reasons.get(b.leadId)! });
          console.error(`[lead-service] subject equivalences: runs-service refused ${b.leadId} -> ${b.targetLeadId} (${reasons.get(b.leadId)})`);
        }
        batch = batch.filter((b) => !reasons.has(b.leadId));
        continue;
      }
      throw new Error(`runs-service subject equivalences failed: ${res.status} - ${res.text}`);
    }
  }
  return summary;
}

export const EQUIVALENCES_INTERVAL_MS = 30 * 60_000;
const EQUIVALENCES_FIRST_DELAY_MS = 4 * 60_000;
let running = false;

/** Background thread: one pass every 30 min (new merges, folds, repairs). */
export function startLeadSubjectEquivalencesWorker(): void {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await stateLeadSubjectEquivalences({ dryRun: false });
      if (s.duplicatesRecorded || s.recorded || s.refused.length) {
        console.log(
          `[lead-service] subject equivalences: duplicates recorded=${s.duplicatesRecorded} stated=${s.recorded} alreadyRecorded=${s.alreadyRecorded} refused=${s.refused.length} skipped=${s.skipped.length}`,
        );
      }
    } catch (err) {
      console.error("[lead-service] subject equivalences pass failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), EQUIVALENCES_FIRST_DELAY_MS).unref();
  setInterval(() => void tick(), EQUIVALENCES_INTERVAL_MS).unref();
}
