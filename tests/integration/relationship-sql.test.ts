/**
 * RELATIONSHIP-TAGS-1014 against a REAL database: the brand's leads = the people crm-service tags professional to
 * the brand (PROFESSIONAL-LEADS-1017; one per human, names over channel labels, nobody else), evidence (signup ->
 * prospect, payment -> customer), personal read off crm-service's connection tag at the human level (never judged),
 * a person's word and its withdrawal, an org's merge folding two people into one row, and the company crm-service
 * links later carrying the lead's tags.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { clearRegistry, connectionTag, organizationLink } from "../helpers/crm-registry.js";

// The brand card the relationship judge reads (LEADS-JUDGE-BRAND-1021): a brand with no active offer here.
vi.mock("../../src/lib/brand-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/brand-client.js")>()),
  getActiveOffers: async () => [],
}));
vi.mock("../../src/lib/company-client.js", () => ({
  getCompanies: async (ids: string[]) => ids.map((brandId) => ({ brandId, name: "Acme", domain: "acme.com" })),
}));
import { refreshSubjects, readThread, subjectKey, toSubject } from "../../src/lib/relationship-subjects.js";
import { writeEvidence } from "../../src/lib/relationship-judge.js";
import { loadRelationships, loadRelationshipsAt, readReview, recomputePolicy, stateTag, withdrawTag } from "../../src/lib/relationship-read.js";
import { relationshipClause } from "../../src/lib/reach-sql.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("relationship tags", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const yuliaWa = randomUUID();
  const yuliia = randomUUID();
  const scope = { orgId, brandId };
  const companyId = randomUUID();
  let seq = BigInt(Date.now()) * 1000n;
  const createdLeads: string[] = [];

  async function fact(p: { personKey: string; human: string | null; name: string; emails?: string[]; phones?: string[]; type: string; source: string; payload?: Record<string, unknown>; at?: string }): Promise<string> {
    const id = randomUUID();
    seq += 1n;
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${id}, ${seq.toString()}::bigint, ${orgId}, ${brandId}, ${p.personKey}, ${p.personKey}, ${p.name}, ${sql.param(p.emails ?? [])}::text[], ${sql.param(p.phones ?? [])}::text[],
        ${p.type}, ${p.at ?? "2026-10-01T10:00:00Z"}::timestamptz, 'event', ${p.source}, ${randomUUID()}, ${JSON.stringify(p.payload ?? {})}::jsonb,
        ${JSON.stringify(p.human ? { humanId: p.human } : {})}::jsonb)
    `);
    return id;
  }

  afterAll(async () => {
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(createdLeads)}::uuid[])`);
    await clearRegistry(orgId);
    for (const t of ["crm_facts", "relationship_person_humans", "relationship_subjects", "relationship_evidence", "relationship_judgments", "relationship_statements", "relationship_companies", "org_human_aliases"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
    }
  });

  it("builds one lead per PROFESSIONAL relation with its own thread and the sources' evidence; nobody else", async () => {
    await connectionTag({ orgId, brandId, human: yuliaWa, personKey: "matrix:room1", name: "Yulia (WA)" });
    await connectionTag({ orgId, brandId, human: yuliia, personKey: "email:lusenko.julija@gmail.com", name: "Yuliia Siletska", emails: ["lusenko.julija@gmail.com"] });
    const friend = randomUUID();
    await connectionTag({ orgId, brandId, human: friend, personKey: "matrix:room2", name: "A friend", tag: "personal_to_user" });
    await fact({ personKey: "matrix:room2", human: friend, name: "A friend", type: "message_in", source: "matrix", payload: { text: "dinner?" } });
    await fact({ personKey: "matrix:room1", human: yuliaWa, name: "Yulia (WA)", type: "message_in", source: "matrix", payload: { text: "see you at the retreat!", channel: "whatsapp" } });
    await fact({ personKey: "email:lusenko.julija@gmail.com", human: yuliia, name: "Yuliia Siletska", emails: ["lusenko.julija@gmail.com"], type: "signup", source: "clerk" });
    await fact({ personKey: "email:lusenko.julija@gmail.com", human: yuliia, name: "Yuliia Siletska", emails: ["lusenko.julija@gmail.com"], type: "payment", source: "stripe", payload: { status: "succeeded", amountMinor: 9900, amountRefunded: 0 } });
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

  it("personal is crm-service's tag at the human level (never judged), a person's word wins and can be withdrawn", async () => {
    // Personal to the founder, stated by crm-service under ANOTHER brand of the org: org-wide.
    await connectionTag({ orgId, brandId: randomUUID(), human: yuliaWa, personKey: "matrix:room1", tag: "personal_to_user" });
    // An old judgment of personal (low here, high elsewhere) is not read any more.
    await db.execute(sql`
      INSERT INTO relationship_judgments (org_id, brand_id, human_id, company_key, probabilities, thread_seq, model, run_id)
      VALUES (${orgId}, ${randomUUID()}, ${yuliaWa}::uuid, '', '{"personal":0.92,"customer":0.1}'::jsonb, 1, 'jev-test', 'run'),
             (${orgId}, ${brandId}, ${yuliaWa}::uuid, '', '{"personal":0.2,"investor":0.45}'::jsonb, 1, 'jev-test', 'run')
    `);
    let b = (await loadRelationships(orgId, brandId, [yuliaWa])).get(yuliaWa)!;
    expect(b.tags).toEqual(["personal"]);
    expect(b.details.find((d) => d.tag === "personal")).toMatchObject({ basis: "evidence", evidence: "crm:personal_to_user" });
    expect(b.connectionTags).toEqual(["personal_to_user", "professional_to_brand"]);
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

  it("an org merge folds both into ONE lead carrying every tag; a company crm-service links later splits the relations", async () => {
    await db.execute(sql`
      INSERT INTO org_human_aliases (org_id, atomic_human_id, human_id) VALUES (${orgId}, ${yuliaWa}::uuid, ${yuliia}::uuid), (${orgId}, ${yuliia}::uuid, ${yuliia}::uuid)
    `);
    await db.execute(sql`UPDATE relationship_judgments SET human_id = ${yuliia}::uuid WHERE org_id = ${orgId}`);
    const r = await refreshSubjects(scope);
    expect(r.subjects).toBe(1); // both relations professional, company unknown: one row
    await writeEvidence(scope);
    const viaOldId = (await loadRelationships(orgId, brandId, [yuliaWa])).get(yuliaWa)!;
    expect(viaOldId.humanId).toBe(yuliia);
    expect(viaOldId.tags.sort()).toEqual(["customer", "personal", "prospect"]);

    // PERSON-RELATIONS-1017: crm reads the email relation at a company; the WhatsApp chat stays "company unknown".
    await organizationLink({ orgId, brandId, human: yuliia, personKey: "email:lusenko.julija@gmail.com", companyId });
    expect((await refreshSubjects(scope)).subjects).toBe(2);
    await writeEvidence(scope);
    const evidence = (await db.execute(sql`SELECT DISTINCT company_key, tag FROM relationship_evidence WHERE org_id = ${orgId} ORDER BY tag`)) as unknown as Array<{ company_key: string; tag: string }>;
    expect(evidence).toEqual([{ company_key: companyId, tag: "customer" }, { company_key: companyId, tag: "prospect" }]);
    const at = await loadRelationshipsAt(orgId, brandId, [{ humanId: yuliia, companyKey: companyId }, { humanId: yuliia, companyKey: "" }]);
    const work = at.get(subjectKey(yuliia, companyId))!;
    expect(work.company).toMatchObject({ id: companyId, name: "Acme", source: "crm" });
    expect(work.tags.sort()).toEqual(["customer", "prospect"]); // the relation's own points: no personal tag there
    const chat = at.get(subjectKey(yuliia, ""))!;
    expect(chat.tags).toEqual([]);
    // Each relation reads only its own thread.
    const rows = (await db.execute(sql`SELECT * FROM relationship_subjects WHERE org_id = ${orgId} ORDER BY company_key`)) as unknown as Array<Record<string, unknown>>;
    expect((await readThread(toSubject(rows[0]))).map((l) => l.text)).toEqual(["see you at the retreat!"]);
    expect((await readThread(toSubject(rows[1]))).map((l) => l.kind).sort()).toEqual(["payment", "signup"]);
    expect(rows.every((x) => x.shares_human === true)).toBe(true);
  });

  it("business_only: fail-closed until decided, a personal tag holds the person back, the pool clause reads it", async () => {
    const [lead] = (await db.execute(sql`INSERT INTO leads (name, human_id) VALUES ('Yuliia', ${yuliaWa}::uuid) RETURNING id::text`)) as unknown as Array<{ id: string }>;
    createdLeads.push(lead.id);
    const allowed = async () =>
      ((await db.execute(sql`SELECT 1 AS ok WHERE TRUE ${relationshipClause(sql`${lead.id}::uuid`, { policy: "business_only", orgId, brandIds: [brandId] })}`)) as unknown as unknown[]).length === 1;
    // The lead's fleet human (Yulia's WhatsApp id) is folded into Yuliia by the org's own link.
    expect(await allowed()).toBe(false);
    await recomputePolicy(orgId, brandId);
    expect(await allowed()).toBe(false); // personal (crm-service) + investor unsure + the work relation never judged
    await db.execute(sql`
      INSERT INTO relationship_judgments (org_id, brand_id, human_id, company_key, probabilities, thread_seq, thread_scope, model, run_id)
      VALUES (${orgId}, ${brandId}, ${yuliia}::uuid, ${companyId}, '{"customer":0.9}'::jsonb, 9e15, 'relation', 'jev-test', 'run')
    `);
    await stateTag({ orgId, brandId, humanId: yuliia, tag: "personal", state: "no", userId: "user-1" });
    await stateTag({ orgId, brandId, humanId: yuliia, tag: "investor", state: "no", userId: "user-1", companyKey: "" });
    expect(await allowed()).toBe(true);
    const block = (await loadRelationships(orgId, brandId, [yuliia])).get(yuliia)!;
    expect(block.policies.business_only).toBe(true);
    await withdrawTag({ orgId, brandId, humanId: yuliia, tag: "personal", userId: "user-1" });
    expect(await allowed()).toBe(false);
  });

  it("a lead's own employer (a local organization row) names the company on the block", async () => {
    const human = randomUUID();
    const [org] = (await db.execute(sql`INSERT INTO organizations (name, primary_domain) VALUES ('Local Co', 'local.co') RETURNING id::text`)) as unknown as Array<{ id: string }>;
    await db.execute(sql`
      INSERT INTO relationship_subjects (org_id, brand_id, human_id, company_key, name) VALUES (${orgId}, ${brandId}, ${human}::uuid, ${org.id}, 'Someone')
    `);
    const b = (await loadRelationships(orgId, brandId, [human])).get(human)!;
    expect(b.company).toEqual({ id: org.id, name: "Local Co", domain: "local.co", source: "lead" });
    await db.execute(sql`DELETE FROM organizations WHERE id = ${org.id}::uuid`);
  });
});
