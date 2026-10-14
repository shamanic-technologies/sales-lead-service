/**
 * RELATIONSHIP-TAGS-1014b against a REAL database: an open "same person?" question the judge already put at
 * or above 50% is linked as its judgment (an answered or doubtful one is left alone), and the person's own
 * block lists the merges that made them, with the link to undo and both names (an absorbed person from its CRM facts).
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const links: Array<{ humanIds: string[]; judgedBy: string }> = [];
const canonical = new Map<string, string>();
vi.mock("../../src/lib/human-identity-client.js", () => ({
  stateHumanLink: vi.fn(async (input: { humanIds: [string, string]; judgedBy: string }) => {
    links.push({ humanIds: input.humanIds, judgedBy: input.judgedBy });
    for (const h of input.humanIds) canonical.set(h, input.humanIds[1]);
    return { changed: true, link: { linkId: `link-${links.length}` }, humanIds: input.humanIds };
  }),
  withdrawHumanLink: vi.fn(async () => ({ changed: true })),
  getHumanInOrg: vi.fn(async (id: string) => {
    const human = canonical.get(id) ?? id;
    const members = [...canonical.entries()].filter(([, c]) => c === human).map(([a]) => a);
    return { humanId: human, memberHumanIds: members.length ? members : [id], emails: [], phones: [], facts: [] };
  }),
}));

const { db } = await import("../../src/db/index.js");
const { settleOpenMerges, orderPair } = await import("../../src/lib/relationship-merges.js");
const { loadRelationships } = await import("../../src/lib/relationship-read.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("relationship merges settled from 50% sure", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const scope = { orgId, brandId };

  afterAll(async () => {
    for (const t of ["relationship_merge_questions", "relationship_subjects", "org_human_aliases", "relationship_person_humans", "crm_facts"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
    }
  });

  async function question(p: number, state: string, answeredBy: string | null = null): Promise<[string, string]> {
    const [a, b] = orderPair(randomUUID(), randomUUID());
    await db.execute(sql`
      INSERT INTO relationship_merge_questions (org_id, brand_id, human_a, human_b, probability, model, run_id, state, answered_by)
      VALUES (${orgId}, ${brandId}, ${a}::uuid, ${b}::uuid, ${p}, 'jev-test', 'run', ${state}, ${answeredBy})
    `);
    return [a, b];
  }

  it("links every open question at >= 50%, leaves the doubt and the answered ones", async () => {
    const [ka, kb] = await question(0.87, "open");
    await question(0.5, "open");
    const doubt = await question(0.45, "open");
    const answered = await question(0.4, "linked", "person:user-1");
    // The merged person keeps the lead row; the absorbed one is named from its own CRM facts.
    await db.execute(sql`
      INSERT INTO relationship_subjects (org_id, brand_id, human_id, company_key, name) VALUES (${orgId}, ${brandId}, ${kb}::uuid, '', 'Kevin Lourd')
    `);
    await db.execute(sql`
      INSERT INTO relationship_person_humans (org_id, brand_id, person_key, atomic_human_id) VALUES (${orgId}, ${brandId}, 'matrix:kevin-pro', ${ka}::uuid)
    `);
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${(BigInt(Date.now()) * 1000n).toString()}::bigint, ${orgId}, ${brandId}, 'matrix:kevin-pro', 'Kevin Lourd Pro (WA)',
        ${sql.param([])}::text[], ${sql.param([])}::text[], 'message_in', now(), 'event', 'matrix', ${randomUUID()}, '{}'::jsonb, '{}'::jsonb)
    `);

    expect(await settleOpenMerges(scope)).toBe(2);
    expect(links.every((l) => l.judgedBy === "jev")).toBe(true);
    const rows = (await db.execute(sql`
      SELECT human_a::text AS a, state, answered_by, link_id FROM relationship_merge_questions WHERE org_id = ${orgId} ORDER BY probability DESC
    `)) as unknown as Array<{ a: string; state: string; answered_by: string | null; link_id: string | null }>;
    expect(rows.map((r) => [r.state, r.answered_by])).toEqual([
      ["linked", "jev"],
      ["linked", "jev"],
      ["open", null],
      ["linked", "person:user-1"],
    ]);
    expect(rows.find((r) => r.a === doubt[0])?.state).toBe("open");
    expect(rows.find((r) => r.a === answered[0])?.link_id).toBeNull();
    expect(await settleOpenMerges(scope)).toBe(0);

    // Both former ids answer for the merged person, whose block names the merge to undo.
    for (const asked of [ka, kb]) {
      const block = (await loadRelationships(orgId, brandId, [asked])).get(asked)!;
      expect(block.humanId).toBe(kb);
      expect(block.merges).toHaveLength(1);
      expect(block.merges[0]).toMatchObject({ humanIds: [ka, kb], names: ["Kevin Lourd Pro (WA)", "Kevin Lourd"], judgedBy: "jev", confidence: 0.87 });
      expect(block.merges[0].linkId).toMatch(/^link-/);
    }
    const doubtBlock = (await loadRelationships(orgId, brandId, [doubt[0]])).get(doubt[0])!;
    expect(doubtBlock.merges).toEqual([]);
  });
});
