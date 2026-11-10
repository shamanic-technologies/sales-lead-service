/**
 * DASH-SPEED-1110-LEAD-R4 against a REAL database: the fleet pass re-derives `last_action_at` only for a scope whose
 * inputs moved since its last pass (migration 0144's change log), and a re-derived scope lands on exactly the value a
 * forced, unconditional re-derivation gives. A write still open during a pass is caught once committed. The judging
 * pass asks a scope again only once its inputs moved.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const judged: string[] = [];
vi.mock("../../src/lib/qualification-judge.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/qualification-judge.js")>()),
  judgeYesNo: vi.fn(async (state: { message: { text: string } }) => {
    judged.push(state.message.text);
    return { probabilities: { automated: 0.02 }, model: "jev-itest" };
  }),
}));

const { db, sql: raw } = await import("../../src/db/index.js");
const acts = await import("../../src/lib/their-acts.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

let seq = BigInt(Date.now()) * 10_000n + 7_000_000n;
const nextSeq = () => (seq += 1n).toString();

describe.skipIf(!hasRealDatabase)("their-acts passes skip unchanged scopes (DASH-SPEED-1110-LEAD-R4)", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const scope = { orgId, brandId };
  const leadIds: string[] = [];
  const point = `gmail:p-${randomUUID().slice(0, 6)}@distribute.you`;
  const humanId = randomUUID();

  afterAll(async () => {
    for (const t of ["lead_crm_acts", "lead_followup_dates", "relationship_subjects", "crm_facts", "crm_registry_facts", "acted_scope_passes", "acted_input_changes"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
    }
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(leadIds)}::uuid[])`);
  });

  async function lead(): Promise<string> {
    const [row] = (await db.execute(sql`INSERT INTO leads (first_name) VALUES ('itest') RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    leadIds.push(row.id);
    await db.execute(sql`INSERT INTO lead_followup_dates (org_id, brand_id, lead_id, next_followup_at, basis) VALUES (${orgId}, ${brandId}, ${row.id}::uuid, now(), 'default')`);
    return row.id;
  }

  async function message(leadId: string, at: string, opts: { judged?: boolean; on?: string } = {}): Promise<string> {
    const factId = randomUUID();
    const on = opts.on ?? point;
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${factId}, ${nextSeq()}::bigint, ${orgId}, ${brandId}, ${on}, ${on}, '{}', '{}', 'message_in', ${at}::timestamptz, 'sent_at', 'gmail', ${randomUUID()},
        ${JSON.stringify({ channel: "email", text: `hello ${factId}` })}::jsonb, '{}'::jsonb)`);
    await db.execute(sql`
      INSERT INTO lead_crm_acts (org_id, brand_id, lead_id, fact_id, type, contact_point, at)
      VALUES (${orgId}, ${brandId}, ${leadId}::uuid, ${factId}, 'message_in', ${on}, ${at}::timestamptz)`);
    if (opts.judged !== false) await judge(factId);
    return factId;
  }

  const judge = (factId: string) =>
    db.execute(sql`INSERT INTO crm_act_judgments (fact_id, automated, probability, model) VALUES (${factId}, false, 0.03, 'jev-itest')`);

  async function registry(type: string, payload: Record<string, unknown>, withdrawnOf: string | null = null): Promise<string> {
    const factId = randomUUID();
    await db.execute(sql`
      INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, withdrawn_of, raw)
      VALUES (${factId}, ${nextSeq()}::bigint, ${orgId}, ${brandId}, ${point}, '{}', '{}', ${type}, 'none', 'crm', ${randomUUID()},
        ${JSON.stringify(payload)}::jsonb, ${withdrawnOf}, '{}'::jsonb)`);
    return factId;
  }

  async function lastActionAt(leadId: string): Promise<string | null> {
    const [r] = (await db.execute(sql`
      SELECT last_action_at FROM lead_followup_dates WHERE org_id = ${orgId} AND brand_id = ${brandId} AND lead_id = ${leadId}::uuid
    `)) as unknown as Array<{ last_action_at: Date | string | null }>;
    return r.last_action_at === null ? null : new Date(r.last_action_at).toISOString();
  }

  /** Every lead's value after the fleet pass, then after a FORCED re-derivation of the scope: must be the same. */
  async function passAndCompare(): Promise<Array<string | null>> {
    await acts.refreshActedAt(null);
    const afterPass = await Promise.all(leadIds.map(lastActionAt));
    await db.execute(sql`UPDATE lead_followup_dates SET last_action_at = NULL WHERE org_id = ${orgId}`);
    await acts.refreshActedAt(scope);
    expect(await Promise.all(leadIds.map(lastActionAt))).toEqual(afterPass);
    return afterPass;
  }

  const moved = async () => (await acts.scopesToRederive([scope])).length === 1;

  it("an unchanged scope runs nothing; every input write re-derives it to the forced value", async () => {
    const a = await lead();
    await db.execute(sql`
      INSERT INTO relationship_subjects (org_id, brand_id, human_id, company_key, contact_points, has_direct)
      VALUES (${orgId}, ${brandId}, ${humanId}::uuid, '', ARRAY[${point}]::text[], true)`);
    const first = await message(a, "2026-10-01T08:00:00Z");
    expect(await moved()).toBe(true);
    expect(await passAndCompare()).toEqual(["2026-10-01T08:00:00.000Z"]);

    // Passed, nothing moved: the pass skips the scope (proof: a value tampered behind its back stays as it is).
    await acts.refreshActedAt(null);
    expect(await moved()).toBe(false);
    await db.execute(sql`UPDATE lead_followup_dates SET last_action_at = '2001-01-01T00:00:00Z' WHERE org_id = ${orgId}`);
    const pass = await acts.refreshActedAt(null);
    expect(await lastActionAt(a)).toBe("2001-01-01T00:00:00.000Z");
    expect(pass.skipped).toBeGreaterThanOrEqual(1);
    await acts.refreshActedAt(scope);

    // A busy column that is no input (the date itself) leaves the scope alone.
    await acts.refreshActedAt(null);
    await db.execute(sql`UPDATE lead_followup_dates SET next_followup_at = now() + interval '3 days', basis = 'send' WHERE org_id = ${orgId}`);
    await db.execute(sql`UPDATE relationship_subjects SET has_direct = false WHERE org_id = ${orgId}`);
    expect(await moved()).toBe(false);

    const steps: Array<[string, () => Promise<unknown>, Array<string | null>]> = [];
    // An unjudged message counts for nothing yet; its judgment moves the scope.
    let later = "";
    steps.push(["new act, not judged yet", async () => { later = await message(a, "2026-10-05T08:00:00Z", { judged: false }); }, ["2026-10-01T08:00:00.000Z"]]);
    steps.push(["its judgment", () => judge(later), ["2026-10-05T08:00:00.000Z"]]);
    let tag = "";
    steps.push(["crm says the conversation is not about the brand", async () => {
      tag = await registry("connection_tag", { tag: "professional_not_to_brand", brandId, userIds: [], basis: [{ kind: "conversation", ref: point }] });
    }, [null]]);
    steps.push(["that tag withdrawn", () => registry("withdrawn", {}, tag), ["2026-10-05T08:00:00.000Z"]]);
    steps.push(["the later act's crm fact withdrawn", () =>
      db.execute(sql`
        INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, withdrawn_of, raw)
        VALUES (${randomUUID()}, ${nextSeq()}::bigint, ${orgId}, ${brandId}, ${point}, '{}', '{}', 'withdrawn', 'none', 'gmail', ${randomUUID()}, '{}'::jsonb, ${later}, '{}'::jsonb)`),
      ["2026-10-01T08:00:00.000Z"]]);
    steps.push(["the point leaves the subject", () => db.execute(sql`UPDATE relationship_subjects SET contact_points = ARRAY['other:x']::text[] WHERE org_id = ${orgId}`), [null]]);
    steps.push(["the point comes back", () => db.execute(sql`UPDATE relationship_subjects SET contact_points = ARRAY[${point}]::text[] WHERE org_id = ${orgId}`), ["2026-10-01T08:00:00.000Z"]]);
    let b = "";
    steps.push(["a new lead's date row, its act already recorded", async () => {
      const [row] = (await db.execute(sql`INSERT INTO leads (first_name) VALUES ('itest-b') RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
      b = row.id;
      // Recorded before the date row exists: the act alone moves the scope, the pass dates nobody yet.
      await message(b, "2026-10-07T08:00:00Z");
      await acts.refreshActedAt(null);
      leadIds.push(b);
      await db.execute(sql`INSERT INTO lead_followup_dates (org_id, brand_id, lead_id, next_followup_at, basis) VALUES (${orgId}, ${brandId}, ${b}::uuid, now(), 'default')`);
    }, ["2026-10-01T08:00:00.000Z", "2026-10-07T08:00:00.000Z"]]);
    steps.push(["an act removed", () => db.execute(sql`DELETE FROM lead_crm_acts WHERE org_id = ${orgId} AND fact_id = ${first}`), [null, "2026-10-07T08:00:00.000Z"]]);

    for (const [what, write, want] of steps) {
      await acts.refreshActedAt(null);
      expect(await moved(), `${what}: settled before`).toBe(false);
      await write();
      expect(await moved(), `${what}: moves the scope`).toBe(true);
      expect(await passAndCompare(), what).toEqual(want);
    }
  });

  it("a write still open during a pass re-derives the scope once it commits", async () => {
    await acts.refreshActedAt(null);
    expect(await moved()).toBe(false);
    const a = leadIds[0];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const begun = new Promise<void>((r) => { started = r; });
    const lateFact = randomUUID();
    const open = raw.begin(async (tx) => {
      await (tx as unknown as typeof raw)`
        INSERT INTO lead_crm_acts (org_id, brand_id, lead_id, fact_id, type, contact_point, at)
        VALUES (${orgId}, ${brandId}, ${a}::uuid, ${lateFact}, 'signup', ${point}, '2026-11-01T00:00:00Z')`;
      started();
      await gate;
    });
    await begun;
    // The scope moves for another reason meanwhile; the pass reads it while the late write is still open.
    await db.execute(sql`INSERT INTO acted_input_changes (org_id, brand_id) VALUES (${orgId}, ${brandId})`);
    await acts.refreshActedAt(null);
    expect(await lastActionAt(a)).not.toBe("2026-11-01T00:00:00.000Z");
    release();
    await open;
    expect(await moved()).toBe(true);
    await acts.refreshActedAt(null);
    expect(await lastActionAt(a)).toBe("2026-11-01T00:00:00.000Z");
  });

  it("the judging pass asks a scope again only once its inputs moved", async () => {
    const a = leadIds[0];
    // A message on a point that is no subject's: never countable, so never judged; asked once, then left alone.
    await message(a, "2026-11-02T00:00:00Z", { judged: false, on: "gmail:nobody@distribute.you" });
    judged.length = 0;
    const judgedXmin = async () => {
      const [pass] = (await db.execute(sql`SELECT judged_xmin::text AS x FROM acted_scope_passes WHERE org_id = ${orgId} AND brand_id = ${brandId}`)) as unknown as Array<{ x: string | null }>;
      return pass?.x ?? null;
    };
    await acts.judgeAutomatedActs(5);
    const asked = await judgedXmin();
    expect(asked).not.toBeNull();
    expect(judged).toEqual([]);
    // Nothing moved: not asked again (a scope asked and found empty records a NEW xmin).
    await db.execute(sql`SELECT pg_sleep(0.01)`);
    await acts.judgeAutomatedActs(5);
    expect(await judgedXmin()).toBe(asked);
    // A countable unjudged message: the scope moved, it is asked and judged.
    const fresh = await message(a, "2026-11-03T00:00:00Z", { judged: false });
    await acts.judgeAutomatedActs(5);
    expect(judged).toEqual([`hello ${fresh}`]);
  });
});
