/**
 * HOT-INBOUND-UNANSWERED-1016 against a REAL database: every person who WRITES to a brand is tagged lead yes/no and,
 * if a lead, wants business yes/no. A Gmail-only inbound person in no campaign (the DefiniteJobs case: emailed,
 * signed up) reads lead yes + wants business yes; a friend writing private messages reads lead no; a "no thanks"
 * lead reads wants business no; a reply to our outreach counts as writing to us; a person's word outranks Jev.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const asked: Array<{ thread: Array<{ text: string | null }> }> = [];
let nextP = 0.93;
vi.mock("../../src/lib/qualification-judge.js", () => ({
  judgeYesNo: async (state: { thread: Array<{ text: string | null }> }, questions: Record<string, unknown>) => {
    asked.push(state);
    return { probabilities: Object.fromEntries(Object.keys(questions).map((k) => [k, nextP])), model: "jev-test" };
  },
  judgeChoice: async () => {
    throw new Error("not used");
  },
}));
vi.mock("../../src/lib/company-client.js", () => ({
  getCompanies: async (ids: string[]) => ids.map((id) => ({ brandId: id, name: "Distribute.you", domain: "distribute.you" })),
  CompanyServiceError: class extends Error {},
}));

const { db } = await import("../../src/db/index.js");
const { refreshSubjects } = await import("../../src/lib/relationship-subjects.js");
const { writeEvidence } = await import("../../src/lib/relationship-judge.js");
const { intentSubjectsToJudge, judgeIntent } = await import("../../src/lib/relationship-intent-judge.js");
const { loadRelationships, readBrandIntent, readReview, stateTag, withdrawTag } = await import("../../src/lib/relationship-read.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("relationship intent: lead? wants business?", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const scope = { orgId, brandId };
  const inbound = randomUUID(); // Gmail + signup, never in any campaign
  const friend = randomUUID(); // private WhatsApp messages
  const noThanks = randomUUID(); // a prospect who declined
  const coldOnly = randomUUID(); // we wrote, they never did
  const replier = randomUUID(); // replied to our outreach (timeline), known to the CRM only by our send
  let seq = BigInt(Date.now()) * 1000n;
  const createdLeads: string[] = [];

  async function fact(p: { personKey: string; human: string; name: string; emails?: string[]; type: string; source: string; text?: string; at?: string }): Promise<void> {
    seq += 1n;
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${seq.toString()}::bigint, ${orgId}, ${brandId}, ${p.personKey}, ${p.name}, ${sql.param(p.emails ?? [])}::text[], ${sql.param([])}::text[],
        ${p.type}, ${p.at ?? "2026-10-13T10:00:00Z"}::timestamptz, 'event', ${p.source}, ${randomUUID()}, ${JSON.stringify(p.text ? { text: p.text } : {})}::jsonb,
        ${JSON.stringify({ humanId: p.human })}::jsonb)
    `);
  }

  async function judgment(human: string, probabilities: Record<string, number>): Promise<void> {
    await db.execute(sql`
      INSERT INTO relationship_judgments (org_id, brand_id, human_id, company_key, probabilities, thread_seq, model, run_id)
      SELECT ${orgId}, ${brandId}, ${human}::uuid, company_key, ${JSON.stringify(probabilities)}::jsonb, thread_seq, 'jev-test', 'run'
      FROM relationship_subjects WHERE org_id = ${orgId} AND brand_id = ${brandId} AND human_id = ${human}::uuid
    `);
  }

  afterAll(async () => {
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(createdLeads)}::uuid[])`);
    for (const t of ["crm_facts", "relationship_person_humans", "relationship_subjects", "relationship_evidence", "relationship_judgments", "relationship_intent_judgments", "relationship_statements", "lead_timeline_facts"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
    }
  });

  it("marks who wrote to us, from every channel and from replies to our outreach", async () => {
    await fact({ personKey: "email:admin@definitejobs.co.uk", human: inbound, name: "Definite Jobs", emails: ["Admin@DefiniteJobs.co.uk"], type: "message_in", source: "gmail", text: "We are looking for a reliable, affordable, long-term cold email sending partner." });
    await fact({ personKey: "email:admin@definitejobs.co.uk", human: inbound, name: "Definite Jobs", emails: ["admin@definitejobs.co.uk"], type: "signup", source: "clerk", at: "2026-10-13T12:00:00Z" });
    await fact({ personKey: "email:admin@definitejobs.co.uk", human: inbound, name: "Definite Jobs", emails: ["admin@definitejobs.co.uk"], type: "message_in", source: "gmail", text: "Any update on the sending?", at: "2026-10-15T09:00:00Z" });
    await fact({ personKey: "matrix:friend", human: friend, name: "Sam", type: "message_in", source: "matrix", text: "dinner on friday? the kids miss you" });
    await fact({ personKey: "email:jo@acme.io", human: noThanks, name: "Jo", emails: ["jo@acme.io"], type: "message_in", source: "gmail", text: "No thanks, not for us." });
    await fact({ personKey: "email:cold@x.io", human: coldOnly, name: "Cold", emails: ["cold@x.io"], type: "message_out", source: "gmail", text: "Hi, quick question" });
    await fact({ personKey: "email:rep@y.io", human: replier, name: "Rep", emails: ["rep@y.io"], type: "message_out", source: "gmail", text: "following up" });
    const [lead] = (await db.execute(sql`INSERT INTO leads (name, human_id) VALUES ('Rep', ${replier}::uuid) RETURNING id::text`)) as unknown as Array<{ id: string }>;
    createdLeads.push(lead.id);
    await db.execute(sql`
      INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, label, source, source_ref, occurred_at, attribution_basis)
      VALUES (${`itest:${randomUUID()}`}, ${orgId}, ${brandId}, ${lead.id}::uuid, 'interested', 'reply', 'r1', '2026-10-14T08:00:00Z', 'reaction_to_our_email')
    `);

    await refreshSubjects(scope);
    await writeEvidence(scope);
    const rows = (await db.execute(sql`
      SELECT human_id::text AS h, wrote_to_us, last_inbound_at FROM relationship_subjects WHERE org_id = ${orgId}
    `)) as unknown as Array<{ h: string; wrote_to_us: boolean; last_inbound_at: Date | string | null }>;
    const wrote = new Map(rows.map((r) => [r.h, r.wrote_to_us]));
    expect(wrote.get(inbound)).toBe(true);
    expect(wrote.get(friend)).toBe(true);
    expect(wrote.get(noThanks)).toBe(true);
    expect(wrote.get(coldOnly)).toBe(false);
    expect(wrote.get(replier)).toBe(true);
    expect(new Date(rows.find((r) => r.h === inbound)!.last_inbound_at as string).toISOString()).toBe("2026-10-15T09:00:00.000Z");
  });

  it("a Gmail-only inbound person in no campaign: lead yes (signup), judged, wants business yes", async () => {
    let b = (await loadRelationships(orgId, brandId, [inbound])).get(inbound)!;
    expect(b.wroteToUs).toBe(true);
    expect(b.lead).toEqual({ state: "yes", basis: "evidence", tags: ["prospect"] });
    expect(b.wantsBusiness).toMatchObject({ state: null, reason: "not_judged_yet" });

    await judgment(friend, { personal: 0.95, prospect: 0.05, customer: 0.02 });
    await judgment(noThanks, { prospect: 0.9, customer: 0.05 });
    await judgment(replier, { prospect: 0.8, customer: 0.05 });
    await judgment(coldOnly, { prospect: 0.8, customer: 0.05 });

    const todo = await intentSubjectsToJudge(scope, 10);
    expect(todo.map((s) => s.humanId).sort()).toEqual([inbound, noThanks, replier].sort());

    nextP = 0.93;
    await judgeIntent(todo.find((s) => s.humanId === inbound)!, "run-1");
    expect(asked.at(-1)!.thread.map((l) => l.text)).toContain("Any update on the sending?");
    nextP = 0.08;
    await judgeIntent(todo.find((s) => s.humanId === noThanks)!, "run-1");
    nextP = 0.45;
    await judgeIntent(todo.find((s) => s.humanId === replier)!, "run-1");

    b = (await loadRelationships(orgId, brandId, [inbound])).get(inbound)!;
    expect(b.wantsBusiness).toMatchObject({ state: "yes", basis: "judgment", confidence: 0.93, reason: null });
    expect(await intentSubjectsToJudge(scope, 10)).toEqual([]);
  });

  it("a friend is no lead, a 'no thanks' lead does not want business, a non-writer is not asked", async () => {
    const blocks = await loadRelationships(orgId, brandId, [friend, noThanks, coldOnly, replier]);
    expect(blocks.get(friend)!.lead.state).toBe("no");
    expect(blocks.get(friend)!.wantsBusiness).toMatchObject({ state: null, reason: "not_a_lead" });
    expect(blocks.get(noThanks)!.lead.state).toBe("yes");
    expect(blocks.get(noThanks)!.wantsBusiness).toMatchObject({ state: "no", basis: "judgment" });
    expect(blocks.get(coldOnly)!.wantsBusiness).toMatchObject({ state: null, reason: "has_not_written" });
    expect(blocks.get(replier)!.wantsBusiness.state).toBe("unsure");
  });

  it("serves every writer brand-wide, matchable on lower-cased email; the review asks the unsure ones", async () => {
    const people = await readBrandIntent(orgId, brandId);
    expect(people.map((p) => p.humanId).sort()).toEqual([inbound, friend, noThanks, replier].sort());
    const dj = people.find((p) => p.emails.includes("admin@definitejobs.co.uk"))!;
    expect(dj.lead.state).toBe("yes");
    expect(dj.wantsBusiness.state).toBe("yes");
    expect(people[0].humanId).toBe(inbound); // newest writer first

    const review = await readReview(orgId, brandId);
    expect(review.intentQuestions).toEqual([{ humanId: replier, name: "Rep", answer: "wants_business", confidence: 0.45 }]);
    expect(review.counts).toMatchObject({ wroteToUs: 4, leads: 3, wantsBusiness: 1, unsureIntent: 1 });
  });

  it("a person's word outranks the judge and can be withdrawn; a new message asks the judge again", async () => {
    await stateTag({ orgId, brandId, humanId: noThanks, tag: "wants_business", state: "yes", userId: "user-1" });
    let b = (await loadRelationships(orgId, brandId, [noThanks])).get(noThanks)!;
    expect(b.wantsBusiness).toMatchObject({ state: "yes", basis: "person" });
    expect(b.tags).toEqual(["prospect"]); // the statement is no tag
    expect(await withdrawTag({ orgId, brandId, humanId: noThanks, tag: "wants_business", userId: "user-1" })).toBe(true);
    b = (await loadRelationships(orgId, brandId, [noThanks])).get(noThanks)!;
    expect(b.wantsBusiness).toMatchObject({ state: "no", basis: "judgment" });

    await fact({ personKey: "email:jo@acme.io", human: noThanks, name: "Jo", emails: ["jo@acme.io"], type: "message_in", source: "gmail", text: "Actually, can we talk next week?", at: "2026-10-16T09:00:00Z" });
    await refreshSubjects(scope);
    expect((await intentSubjectsToJudge(scope, 10)).map((s) => s.humanId)).toEqual([noThanks]);
  });
});
