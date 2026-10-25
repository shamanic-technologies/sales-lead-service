/**
 * LEDGER-RESIDUAL-1025 against a REAL database (runs-service's door mocked): our own identity records (a repaired
 * served row, a recorded duplicate, a found-twice duplicate, a folded engager) become ONE target per group, stated
 * once; a 422 refusal is kept refused; a replay states nothing new; two humans stay two subjects.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { stateLeadSubjectEquivalences } = await import("../../src/lib/lead-subject-equivalences.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("lead subject equivalences", () => {
  const made: string[] = [];
  const company = randomUUID();
  const human = randomUUID();

  async function lead(createdAt: string, humanId: string | null = null): Promise<string> {
    const rows = (await db.execute(sql`
      INSERT INTO leads (created_at, human_id, company_id) VALUES (${createdAt}::timestamptz, ${humanId}::uuid, ${humanId ? company : null}::uuid)
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    made.push(rows[0].id);
    return rows[0].id;
  }

  afterAll(async () => {
    if (made.length === 0) return;
    await db.execute(sql`DELETE FROM lead_subject_equivalences WHERE lead_id = ANY(${sql.param(made)}::uuid[]) OR target_lead_id = ANY(${sql.param(made)}::uuid[])`);
    await db.execute(sql`DELETE FROM lead_identity_folds WHERE into_lead_id = ANY(${sql.param(made)}::uuid[])`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE lead_id = ANY(${sql.param(made)}::uuid[])`);
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(made)}::uuid[])`);
  });

  it("states each group onto its oldest living lead once, keeps a refusal, and a replay states nothing new", async () => {
    // Found twice: one human at one company holds two leads (no merge recorded them).
    const older = await lead("2026-02-25T03:34:37Z", human);
    const newer = await lead("2026-06-06T01:03:36Z", human);
    // A served row repaired from a lead that could not hold its email onto the email owner.
    const repairedFrom = await lead("2026-03-01T00:00:00Z");
    const owner = await lead("2026-04-01T00:00:00Z");
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, repointed_from_lead_id)
      VALUES (${owner}::uuid, ${randomUUID()}, ${randomUUID()}, ARRAY[${randomUUID()}]::text[], 'served', ${repairedFrom}::uuid)
    `);
    // A social engager folded into an email lead, its row dropped.
    const into = await lead("2026-05-01T00:00:00Z");
    const folded = randomUUID();
    await db.execute(sql`INSERT INTO lead_identity_folds (from_lead_id, into_lead_id) VALUES (${folded}::uuid, ${into}::uuid)`);
    // Two humans at one company: never one subject here.
    const strangerA = await lead("2026-01-01T00:00:00Z", randomUUID());
    await lead("2026-01-02T00:00:00Z", randomUUID());

    const dry = await stateLeadSubjectEquivalences({ dryRun: true }, async () => {
      throw new Error("a dry run never posts");
    });
    const mine = new Set([newer, repairedFrom, folded]);
    expect(dry.duplicatesRecorded).toBe(0);
    expect(dry.planned).toBeGreaterThanOrEqual(3);

    const sent: Array<{ subjectId: string; targetId: string }> = [];
    const first = await stateLeadSubjectEquivalences({ dryRun: false }, async (body) => {
      const items = (body as { items: Array<{ subjectId: string; targetId: string; subjectService: string; targetService: string }> }).items;
      expect(items.every((i) => i.subjectService === "lead-service" && i.targetService === "lead-service")).toBe(true);
      const refuseAt = items.findIndex((i) => i.subjectId === folded);
      if (refuseAt >= 0) return { status: 422, text: JSON.stringify({ error: "invalid_equivalences", details: { refusals: [{ index: refuseAt, reason: "conflicting_target" }] } }) };
      sent.push(...items.filter((i) => mine.has(i.subjectId)));
      return { status: 200, text: JSON.stringify({ recordedCount: items.length, alreadyRecordedCount: 0 }) };
    });
    expect(first.duplicatesRecorded).toBeGreaterThanOrEqual(1);
    expect(sent.map((x) => `${x.subjectId}>${x.targetId}`).sort()).toEqual([`${newer}>${older}`].sort());
    const stated = (await db.execute(sql`
      SELECT lead_id::text AS lead, target_lead_id::text AS target, status, refused_reason
      FROM lead_subject_equivalences WHERE lead_id = ANY(${sql.param([newer, owner, repairedFrom, folded, strangerA])}::uuid[])
      ORDER BY lead_id
    `)) as unknown as Array<{ lead: string; target: string; status: string; refused_reason: string | null }>;
    const byLead = new Map(stated.map((r) => [r.lead, r]));
    expect(byLead.get(newer)).toMatchObject({ target: older, status: "stated" });
    expect(byLead.get(owner)).toMatchObject({ target: repairedFrom, status: "stated" });
    expect(byLead.get(folded)).toMatchObject({ target: into, status: "refused", refused_reason: "conflicting_target" });
    expect(byLead.has(repairedFrom)).toBe(false);
    expect(byLead.has(strangerA)).toBe(false);
    const dup = (await db.execute(sql`SELECT survivor_lead_id::text AS s, reason FROM lead_identity_duplicates WHERE lead_id = ${newer}::uuid`)) as unknown as Array<{ s: string; reason: string }>;
    expect(dup).toEqual([{ s: older, reason: "found_twice" }]);

    const replay = await stateLeadSubjectEquivalences({ dryRun: false }, async (body) => {
      const items = (body as { items: Array<{ subjectId: string }> }).items;
      expect(items.some((i) => mine.has(i.subjectId) || i.subjectId === owner)).toBe(false);
      return { status: 200, text: JSON.stringify({ recordedCount: 0, alreadyRecordedCount: items.length }) };
    });
    expect(replay.duplicatesRecorded).toBe(0);
  });
});
