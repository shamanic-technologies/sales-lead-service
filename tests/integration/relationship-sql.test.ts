/**
 * RELATIONSHIP-TAGS-1014 against a REAL database: the brand's leads built from the CRM feed (one per
 * human, names over channel labels), evidence (signup -> prospect, payment -> customer), the block read
 * with personal at the human level, a person's word and its withdrawal, an org's merge folding two
 * people into one row, and a company found later carrying the lead's tags.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { refreshSubjects, readThread, toSubject } from "../../src/lib/relationship-subjects.js";
import { writeEvidence } from "../../src/lib/relationship-judge.js";
import { loadRelationships, readReview, stateTag, withdrawTag } from "../../src/lib/relationship-read.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("relationship tags", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const yuliaWa = randomUUID();
  const yuliia = randomUUID();
  const scope = { orgId, brandId };
  let seq = BigInt(Date.now()) * 1000n;

  async function fact(p: { personKey: string; human: string | null; name: string; emails?: string[]; phones?: string[]; type: string; source: string; payload?: Record<string, unknown>; at?: string }): Promise<string> {
    const id = randomUUID();
    seq += 1n;
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${id}, ${seq.toString()}::bigint, ${orgId}, ${brandId}, ${p.personKey}, ${p.name}, ${sql.param(p.emails ?? [])}::text[], ${sql.param(p.phones ?? [])}::text[],
        ${p.type}, ${p.at ?? "2026-10-01T10:00:00Z"}::timestamptz, 'event', ${p.source}, ${randomUUID()}, ${JSON.stringify(p.payload ?? {})}::jsonb,
        ${JSON.stringify(p.human ? { humanId: p.human } : {})}::jsonb)
    `);
    return id;
  }

  afterAll(async () => {
    for (const t of ["crm_facts", "relationship_person_humans", "relationship_subjects", "relationship_evidence", "relationship_judgments", "relationship_statements", "relationship_companies", "org_human_aliases"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
    }
  });

  it("builds one lead per human with its whole thread and the sources' evidence", async () => {
    await fact({ personKey: "matrix:room1", human: yuliaWa, name: "Yulia (WA)", type: "message_in", source: "matrix", payload: { text: "see you at the retreat!", channel: "whatsapp" } });
    await fact({ personKey: "email:lusenko.julija@gmail.com", human: yuliia, name: "Yuliia Siletska", emails: ["lusenko.julija@gmail.com"], type: "signup", source: "clerk" });
    await fact({ personKey: "email:lusenko.julija@gmail.com", human: yuliia, name: "Yuliia Siletska", emails: ["lusenko.julija@gmail.com"], type: "payment", source: "stripe", payload: { amount: 9900 } });
    const withdrawn = await fact({ personKey: "email:lusenko.julija@gmail.com", human: yuliia, name: "Yuliia Siletska", emails: ["lusenko.julija@gmail.com"], type: "form_submitted", source: "crm" });
    await fact({ personKey: "email:lusenko.julija@gmail.com", human: null, name: "Yuliia Siletska", type: "withdrawn", source: "crm" });
    await db.execute(sql`UPDATE crm_facts SET withdrawn_of = ${withdrawn} WHERE org_id = ${orgId} AND type = 'withdrawn'`);

    const r = await refreshSubjects(scope);
    expect(r).toMatchObject({ subjects: 2, withoutHuman: 0 });
    const rows = (await db.execute(sql`SELECT * FROM relationship_subjects WHERE org_id = ${orgId} ORDER BY name`)) as unknown as Array<Record<string, unknown>>;
    expect(rows.map((x) => x.name)).toEqual(["Yulia (WA)", "Yuliia Siletska"]);
    const thread = await readThread(toSubject(rows[0]));
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ kind: "message", direction: "in", text: "see you at the retreat!" });

    await writeEvidence(scope);
    const blocks = await loadRelationships(orgId, brandId, [yuliia, yuliaWa]);
    expect(blocks.get(yuliia)!.tags.sort()).toEqual(["customer", "prospect"]);
    expect(blocks.get(yuliia)!.judgedAt).toBeNull();
    expect(blocks.get(yuliaWa)!.tags).toEqual([]);
  });

  it("personal is read at the human level, a person's word wins and can be withdrawn", async () => {
    await db.execute(sql`
      INSERT INTO relationship_judgments (org_id, brand_id, human_id, company_key, probabilities, thread_seq, model, run_id)
      VALUES (${orgId}, ${randomUUID()}, ${yuliaWa}::uuid, '', '{"personal":0.92,"customer":0.1}'::jsonb, 1, 'jev-test', 'run'),
             (${orgId}, ${brandId}, ${yuliaWa}::uuid, '', '{"personal":0.2,"investor":0.5}'::jsonb, 1, 'jev-test', 'run')
    `);
    let b = (await loadRelationships(orgId, brandId, [yuliaWa])).get(yuliaWa)!;
    expect(b.tags).toEqual(["personal"]);
    expect(b.unsureTags).toEqual(["investor"]);
    expect(b.judgedAt).not.toBeNull();

    await stateTag({ orgId, brandId, humanId: yuliaWa, tag: "investor", state: "no", userId: "user-1" });
    await stateTag({ orgId, brandId, humanId: yuliaWa, tag: "investor", state: "no", userId: "user-1" });
    b = (await loadRelationships(orgId, brandId, [yuliaWa])).get(yuliaWa)!;
    expect(b.unsureTags).toEqual([]);
    expect(b.details.find((d) => d.tag === "investor")).toMatchObject({ state: "no", basis: "person" });
    expect(await withdrawTag({ orgId, brandId, humanId: yuliaWa, tag: "investor", userId: "user-1" })).toBe(true);
    b = (await loadRelationships(orgId, brandId, [yuliaWa])).get(yuliaWa)!;
    expect(b.unsureTags).toEqual(["investor"]);

    const review = await readReview(orgId, brandId);
    expect(review.tagQuestions.map((q) => q.tag)).toEqual(["investor"]);
    expect(review.counts.byTag).toMatchObject({ personal: 1, customer: 1, prospect: 1 });
  });

  it("an org merge folds both into ONE lead carrying every tag; a found company carries them", async () => {
    await db.execute(sql`
      INSERT INTO org_human_aliases (org_id, atomic_human_id, human_id) VALUES (${orgId}, ${yuliaWa}::uuid, ${yuliia}::uuid), (${orgId}, ${yuliia}::uuid, ${yuliia}::uuid)
    `);
    await db.execute(sql`UPDATE relationship_judgments SET human_id = ${yuliia}::uuid WHERE org_id = ${orgId}`);
    const r = await refreshSubjects(scope);
    expect(r.subjects).toBe(1);
    await writeEvidence(scope);
    const viaOldId = (await loadRelationships(orgId, brandId, [yuliaWa])).get(yuliaWa)!;
    expect(viaOldId.humanId).toBe(yuliia);
    expect(viaOldId.tags.sort()).toEqual(["customer", "personal", "prospect"]);

    const companyId = randomUUID();
    await db.execute(sql`
      INSERT INTO relationship_companies (org_id, human_id, company_id, name, domain, source) VALUES (${orgId}, ${yuliia}::uuid, ${companyId}, 'Acme', 'acme.com', 'treg_enrich')
    `);
    await refreshSubjects(scope);
    const moved = (await db.execute(sql`SELECT DISTINCT company_key FROM relationship_evidence WHERE org_id = ${orgId}`)) as unknown as Array<{ company_key: string }>;
    expect(moved.map((m) => m.company_key)).toEqual([companyId]);
    const b = (await loadRelationships(orgId, brandId, [yuliia])).get(yuliia)!;
    expect(b.company).toMatchObject({ id: companyId, name: "Acme", source: "treg_enrich" });
    expect(b.tags.sort()).toEqual(["customer", "personal", "prospect"]);
  });
});
