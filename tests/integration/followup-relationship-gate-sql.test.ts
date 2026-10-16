/**
 * REPLY-ANY-LEAD-1015 against a REAL database: a claim stating `relationships: "pure_prospect"` hands out a
 * prospect, REFUSES a personal contact or a customer (named, row stopped, never offered again), judges a
 * never-judged subject on demand, and leaves an undecidable person due (pending). A claim stating nothing is
 * today's claim.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: async () => ({ results: [] }),
}));
vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchCampaign: async (id: string) => ({ id, createdAt: "2020-01-01T00:00:00.000Z" }),
}));
vi.mock("../../src/lib/company-client.js", () => ({
  getCompanies: async () => [],
}));
const judgeYesNo = vi.fn();
vi.mock("../../src/lib/qualification-judge.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/qualification-judge.js")>()),
  judgeYesNo: (...args: unknown[]) => judgeYesNo(...args),
}));

const { db } = await import("../../src/db/index.js");
const { pickFollowupCandidate, readFollowupState } = await import("../../src/lib/followup-queue.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

const LOW = { personal: 0.05, customer: 0.05, prospect: 0.8, team: 0.05, investor: 0.05, advisor: 0.05, supplier: 0.05, partner: 0.05, other_professional: 0.05 };

describe.skipIf(!hasRealDatabase)("claim-next under a relationship policy", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const acting = `itest-responder-${randomUUID()}`;
  const createdLeads: string[] = [];
  let campaignId = "";
  let seq = BigInt(Date.now()) * 1000n + 500n;

  async function dueLead(p: { human?: string | null; email?: string } = {}): Promise<{ rowId: string; leadId: string; email: string; human: string | null }> {
    const human = p.human === undefined ? randomUUID() : p.human;
    const email = p.email ?? `${randomUUID()}@example.test`;
    const [lead] = (await db.execute(sql`
      INSERT INTO leads (name, human_id) VALUES (${"itest " + email}, ${human}::uuid) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    createdLeads.push(lead.id);
    await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${lead.id}::uuid, 'email', ${email}, 'itest')`);
    const [row] = (await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at, followup_due_at, followup_count)
      VALUES (${lead.id}::uuid, ${campaignId}, ${orgId}, ${sql.param([brandId])}::text[], 'served', now(), now() - interval '1 minute', 0)
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return { rowId: row.id, leadId: lead.id, email, human };
  }

  /** A person known by PHONE only (a WhatsApp writer, REPLY-PHONE-ONLY-1015): no email contact method. */
  async function duePhoneLead(p: { human?: string | null } = {}): Promise<{ rowId: string; leadId: string; phone: string; human: string | null }> {
    const human = p.human === undefined ? randomUUID() : p.human;
    const phone = `+3361${String(Math.floor(1e7 + Math.random() * 9e7))}`;
    const [lead] = (await db.execute(sql`
      INSERT INTO leads (name, human_id) VALUES ('itest whatsapp writer', ${human}::uuid) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    createdLeads.push(lead.id);
    await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${lead.id}::uuid, 'phone', ${phone}, 'itest')`);
    const [row] = (await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at, followup_due_at, followup_count)
      VALUES (${lead.id}::uuid, ${campaignId}, ${orgId}, ${sql.param([brandId])}::text[], 'served', now(), now() - interval '1 minute', 0)
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return { rowId: row.id, leadId: lead.id, phone, human };
  }

  async function subject(human: string, emails: string[] = []): Promise<void> {
    await db.execute(sql`
      INSERT INTO relationship_subjects (org_id, brand_id, human_id, company_key, name, emails, thread_seq, has_messages, has_direct)
      VALUES (${orgId}, ${brandId}, ${human}::uuid, '', 'itest', ${sql.param(emails)}::text[], 1, true, true)
    `);
  }

  async function judged(human: string, probabilities: Record<string, number>): Promise<void> {
    await db.execute(sql`
      INSERT INTO relationship_judgments (org_id, brand_id, human_id, company_key, probabilities, thread_seq, model, run_id)
      VALUES (${orgId}, ${brandId}, ${human}::uuid, '', ${JSON.stringify(probabilities)}::jsonb, 1, 'jev-test', 'run')
    `);
  }

  async function crmFact(email: string): Promise<void> {
    seq += 1n;
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${seq.toString()}::bigint, ${orgId}, ${brandId}, ${"email:" + email}, 'itest', ${sql.param([email])}::text[], '{}'::text[],
        'message_in', now(), 'event', 'matrix', ${randomUUID()}, '{}'::jsonb, '{}'::jsonb)
    `);
  }

  const claim = (relationships?: "pure_prospect") =>
    pickFollowupCandidate({
      orgId,
      campaignId,
      runId: randomUUID(),
      actingCampaignId: acting,
      context: { orgId },
      ...(relationships ? { relationships } : {}),
    });

  beforeEach(() => {
    campaignId = `itest-rel-gate-${randomUUID()}`;
    judgeYesNo.mockReset();
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM followup_actions WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM followup_responders WHERE first_responder_campaign_id = ${acting}`);
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(createdLeads)}::uuid[])`);
    for (const t of ["crm_facts", "relationship_subjects", "relationship_judgments", "relationship_evidence", "relationship_statements"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
    }
  });

  it("hands out a prospect nobody of the org knows outside our outreach", async () => {
    const p = await dueLead();
    const r = await claim("pure_prospect");
    expect(r.claimed?.id).toBe(p.rowId);
    expect(r.relationships).toEqual({ policy: "pure_prospect", refused: [], pending: [] });
  });

  it("hands out a judged subject held as prospect", async () => {
    const p = await dueLead();
    await subject(p.human!, [p.email]);
    await judged(p.human!, LOW);
    const r = await claim("pure_prospect");
    expect(r.claimed?.id).toBe(p.rowId);
  });

  it("refuses a personal contact by name, stops the row, and never offers it again", async () => {
    const p = await dueLead();
    await subject(p.human!, [p.email]);
    await judged(p.human!, { ...LOW, personal: 0.92 });

    const r = await claim("pure_prospect");
    expect(r.claimed).toBeNull();
    expect(r).toMatchObject({ reason: "relationship_refused" });
    expect(r.relationships!.refused).toEqual([
      { leadCampaignId: p.rowId, leadId: p.leadId, campaignId, email: p.email, phone: null, reason: "not_a_lead", tags: ["personal"], unsureTags: [] },
    ]);
    const state = await readFollowupState(orgId, p.rowId);
    expect(state).toMatchObject({ dueAt: null, claimedAt: null, stoppedReason: "relationship_not_a_lead" });

    const again = await claim("pure_prospect");
    expect(again).toMatchObject({ claimed: null, reason: "nothing_due" });
  });

  it("refuses a customer the sources evidence, and an unsure investor, then claims the prospect behind them", async () => {
    const customer = await dueLead();
    await subject(customer.human!, [customer.email]);
    await judged(customer.human!, LOW);
    await db.execute(sql`
      INSERT INTO relationship_evidence (org_id, brand_id, human_id, company_key, tag, evidence, at)
      VALUES (${orgId}, ${brandId}, ${customer.human}::uuid, '', 'customer', 'payment', now())
    `);
    const unsure = await dueLead();
    await subject(unsure.human!, [unsure.email]);
    await judged(unsure.human!, { ...LOW, investor: 0.45 });
    await new Promise((r) => setTimeout(r, 5));
    const prospect = await dueLead();
    // Due last, but strictly in the past on the CLAIM's clock (JS now): a DB `now()` can sit ahead of it and read not due.
    await db.execute(sql`UPDATE leads_campaigns SET followup_due_at = now() - interval '1 second' WHERE id = ${prospect.rowId}::uuid`);

    const r = await claim("pure_prospect");
    expect(r.claimed?.id).toBe(prospect.rowId);
    expect(r.relationships!.refused.map((x) => [x.email, x.tags, x.unsureTags])).toEqual(
      expect.arrayContaining([
        [customer.email, ["customer"], []],
        [unsure.email, [], ["investor"]],
      ]),
    );
  });

  it("judges a never-judged subject on demand inside the claim, then decides", async () => {
    const lead = await dueLead();
    await subject(lead.human!, [lead.email]);
    judgeYesNo.mockResolvedValueOnce({ probabilities: LOW, model: "jev-test" });

    const r = await claim("pure_prospect");
    expect(judgeYesNo).toHaveBeenCalledTimes(1);
    expect(r.claimed?.id).toBe(lead.rowId);
    const j = (await db.execute(sql`SELECT 1 FROM relationship_judgments WHERE org_id = ${orgId} AND human_id = ${lead.human}::uuid`)) as unknown as unknown[];
    expect(j).toHaveLength(1);
  });

  it("an on-demand judgment saying personal refuses", async () => {
    const lead = await dueLead();
    await subject(lead.human!, [lead.email]);
    judgeYesNo.mockResolvedValueOnce({ probabilities: { ...LOW, personal: 0.9 }, model: "jev-test" });
    const r = await claim("pure_prospect");
    expect(r).toMatchObject({ claimed: null, reason: "relationship_refused" });
  });

  it("a judgment that fails leaves the person due and pending, never treated as a lead", async () => {
    const lead = await dueLead();
    await subject(lead.human!, [lead.email]);
    judgeYesNo.mockRejectedValueOnce(new Error("chat-service down"));
    const r = await claim("pure_prospect");
    expect(r).toMatchObject({ claimed: null, reason: "relationship_pending" });
    expect(r.relationships!.pending).toEqual([
      { leadCampaignId: lead.rowId, leadId: lead.leadId, campaignId, email: lead.email, phone: null, reason: "relationship_not_judged", retryAfterSeconds: 300 },
    ]);
    const state = await readFollowupState(orgId, lead.rowId);
    expect(state?.dueAt).not.toBeNull();
    expect(state?.claimedAt).toBeNull();
  });

  it("a person the CRM knows but the sweep has not built yet is pending, not a stranger", async () => {
    const lead = await dueLead();
    await crmFact(lead.email);
    const r = await claim("pure_prospect");
    expect(r).toMatchObject({ claimed: null, reason: "relationship_pending" });
    expect(r.relationships!.pending[0]).toMatchObject({ reason: "relationship_not_built" });
  });

  it("a lead with no human yet is pending", async () => {
    await dueLead({ human: null });
    const r = await claim("pure_prospect");
    expect(r.relationships!.pending[0]).toMatchObject({ reason: "human_unknown" });
  });

  it("an open same-person question is pending", async () => {
    const lead = await dueLead();
    await subject(lead.human!, [lead.email]);
    await judged(lead.human!, LOW);
    const [a, b] = [lead.human!, randomUUID()].sort();
    await db.execute(sql`
      INSERT INTO relationship_merge_questions (org_id, brand_id, human_a, human_b, probability, model, run_id, state)
      VALUES (${orgId}, ${brandId}, ${a}::uuid, ${b}::uuid, 0.45, 'jev-test', 'run', 'open')
    `);
    const r = await claim("pure_prospect");
    expect(r.relationships!.pending[0]).toMatchObject({ reason: "same_person_question_open" });
    await db.execute(sql`DELETE FROM relationship_merge_questions WHERE org_id = ${orgId}`);
  });

  it("a claim stating no policy is today's claim: the personal contact is handed out, no relationships key", async () => {
    const p = await dueLead();
    await subject(p.human!, [p.email]);
    await judged(p.human!, { ...LOW, personal: 0.92 });
    const r = await claim();
    expect(r.claimed?.id).toBe(p.rowId);
    expect("relationships" in r).toBe(false);
  });

  describe("a person known by PHONE only (REPLY-PHONE-ONLY-1015)", () => {
    it("hands out a phone-only prospect: email null, the phone carried", async () => {
      const p = await duePhoneLead();
      const r = await claim("pure_prospect");
      expect(r.claimed).toMatchObject({ id: p.rowId, email: null, phone: p.phone });
    });

    it("refuses a phone-only team member / personal contact of the owner: not_a_lead, row stopped, nothing sent", async () => {
      const p = await duePhoneLead();
      await subject(p.human!);
      await judged(p.human!, { ...LOW, team: 0.9 });
      const r = await claim("pure_prospect");
      expect(r).toMatchObject({ claimed: null, reason: "relationship_refused" });
      expect(r.relationships!.refused).toEqual([
        { leadCampaignId: p.rowId, leadId: p.leadId, campaignId, email: null, phone: p.phone, reason: "not_a_lead", tags: ["team"], unsureTags: [] },
      ]);
      expect(await readFollowupState(orgId, p.rowId)).toMatchObject({ dueAt: null, stoppedReason: "relationship_not_a_lead" });
    });

    it("a phone-only writer the CRM copy names by phone, not built yet, is pending (never admitted blind)", async () => {
      const p = await duePhoneLead();
      seq += 1n;
      await db.execute(sql`
        INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
        VALUES (${randomUUID()}, ${seq.toString()}::bigint, ${orgId}, ${brandId}, ${"phone:" + p.phone}, 'itest', '{}'::text[],
          ${sql.param([p.phone.slice(0, 3) + " " + p.phone.slice(3)])}::text[], 'message_in', now(), 'event', 'whatsapp', ${randomUUID()}, '{}'::jsonb, '{}'::jsonb)
      `);
      const r = await claim("pure_prospect");
      expect(r).toMatchObject({ claimed: null, reason: "relationship_pending" });
      expect(r.relationships!.pending[0]).toMatchObject({ email: null, phone: p.phone, reason: "relationship_not_built" });
    });

    it("a phone-only person whose human carries a live do_not_contact is stopped opted_out, never claimed (no email-gateway read)", async () => {
      const p = await duePhoneLead();
      await db.execute(sql`
        INSERT INTO human_fact_copies (fact_id, human_id, kind, event_id) VALUES (${randomUUID()}, ${p.human}::uuid, 'do_not_contact', 1)
      `);
      const r = await claim();
      expect(r.claimed).toBeNull();
      expect(await readFollowupState(orgId, p.rowId)).toMatchObject({ dueAt: null, stoppedReason: "opted_out" });
      await db.execute(sql`DELETE FROM human_fact_copies WHERE human_id = ${p.human}::uuid`);
    });
  });
});
