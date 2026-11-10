/**
 * DASH-SPEED-1110-LEAD-R4 against a REAL database: the brand's live crm relations kept per brand
 * (`crm-live-relations.ts`) equal the whole read after every kind of registry write (a new relation, a withdrawal, a
 * relation of another brand, a copy committing late, a brand transfer's UPDATE), and nothing is re-read while nothing
 * was copied.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db, sql: raw } = await import("../../src/db/index.js");
const live = await import("../../src/lib/crm-live-relations.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

let seq = BigInt(Date.now()) * 10_000n + 8_000_000n;
const nextSeq = () => (seq += 1n).toString();

describe.skipIf(!hasRealDatabase)("live crm relations kept per brand", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const otherBrand = randomUUID();

  beforeEach(() => live.resetLiveRelations());
  afterAll(async () => {
    await db.execute(sql`DELETE FROM crm_registry_facts WHERE org_id = ${orgId}`);
  });

  async function relation(brand = brandId, at?: string): Promise<string> {
    const id = randomUUID();
    const human = randomUUID();
    await db.execute(sql`
      INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, full_name, emails, phones, type, date_basis, source, source_ref, payload, raw)
      VALUES (${id}, ${at ?? nextSeq()}::bigint, ${orgId}, ${brand}, ${`pk-${id}`}, 'Ann', '{}', '{}', 'relation', 'none', 'crm', ${randomUUID()},
        ${JSON.stringify({
          relationKey: `rel:${human}:pro`, capacity: "professional", companyId: null, domain: null,
          tags: [{ tag: "professional_to_brand", userIds: [], brandId: brand, basis: [{ kind: "conversation", ref: "x" }] }],
          contactPoints: [{ id: `pk-${id}`, kind: "email" }], emails: ["Ann@Example.com"], phones: [], extra: "dropped",
        })}::jsonb, ${JSON.stringify({ humanId: human })}::jsonb)`);
    return id;
  }

  const withdraw = (factId: string) =>
    db.execute(sql`
      INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, withdrawn_of, raw)
      VALUES (${randomUUID()}, ${nextSeq()}::bigint, ${orgId}, ${brandId}, 'pk', '{}', '{}', 'withdrawn', 'none', 'crm', ${randomUUID()}, '{}'::jsonb, ${factId}, '{}'::jsonb)`);

  /** The whole read, as the sweep ran it before (payload trimmed the same way). */
  async function whole(): Promise<string[]> {
    const rows = (await db.execute(sql`
      SELECT f.fact_id, CASE WHEN f.raw->>'humanId' ~* '^[0-9a-f-]{36}$' THEN f.raw->>'humanId' END AS human,
        f.person_key, f.full_name AS name, f.seq::text AS seq, f.payload
      FROM crm_registry_facts f
      WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId} AND f.type = 'relation'
        AND NOT EXISTS (SELECT 1 FROM crm_registry_facts w WHERE w.withdrawn_of = f.fact_id)
    `)) as unknown as live.LiveRelationRow[];
    return rows.map((r) => JSON.stringify({ ...r, payload: live.trimRelationPayload(r.payload) })).sort();
  }
  const kept = async () => (await live.liveRelationRows(orgId, brandId)).map((r) => JSON.stringify(r)).sort();

  it("stays equal to the whole read through every kind of write", async () => {
    const a = await relation();
    const b = await relation();
    expect(await kept()).toEqual(await whole());
    expect((await kept())[0]).not.toContain("dropped");

    const steps: Array<[string, () => Promise<unknown>]> = [
      ["a new relation", () => relation()],
      ["a withdrawal", () => withdraw(a)],
      ["a relation of another brand", () => relation(otherBrand)],
      ["a relation and its withdrawal in one go", async () => withdraw(await relation())],
      ["a brand transfer moves one away", () => db.execute(sql`UPDATE crm_registry_facts SET brand_id = ${otherBrand} WHERE fact_id = ${b}`)],
    ];
    for (const [what, write] of steps) {
      await write();
      expect(await kept(), what).toEqual(await whole());
    }
  });

  it("a copy committing late, with a LOWER seq than one already read, is caught", async () => {
    await kept();
    const lowSeq = (seq - 500n).toString();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started!: () => void;
    const begun = new Promise<void>((r) => { started = r; });
    const id = randomUUID();
    const open = raw.begin(async (tx) => {
      await (tx as unknown as typeof raw)`
        INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, raw)
        VALUES (${id}, ${lowSeq}::bigint, ${orgId}, ${brandId}, ${`pk-${id}`}, '{}', '{}', 'relation', 'none', 'crm', ${randomUUID()},
          ${JSON.stringify({ relationKey: `rel:${id}`, capacity: "professional", tags: [] })}::jsonb, '{}'::jsonb)`;
      started();
      await gate;
    });
    await begun;
    await relation(); // a higher seq, committed first, read while the low one is still open
    expect(await kept()).toEqual(await whole());
    release();
    await open;
    expect((await kept()).some((r) => r.includes(id))).toBe(true);
    expect(await kept()).toEqual(await whole());
  });
});
