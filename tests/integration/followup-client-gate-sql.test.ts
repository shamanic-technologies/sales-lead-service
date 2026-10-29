/**
 * CLIENT-CHECKIN-LEAD-1024 against a REAL database: a claim stating `relationships: "current_client"` hands out a
 * paying customer (the booked stop does not hide them), REFUSES a pure prospect (`not_a_client`), a member of the org
 * who carries a sale (`team_member`), staff (`staff`) and a personal contact who paid (`personal`), each named and
 * their row stopped. `pure_prospect` claims are unchanged (pinned by followup-relationship-gate-sql.test.ts).
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
const memberKeys = new Set<string>();
// A relation at a company names it through brand-service (relationship-read): no company known here.
vi.mock("../../src/lib/company-client.js", () => ({
  getCompanies: async () => [],
}));
vi.mock("../../src/lib/org-members.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/org-members.js")>()),
  loadOrgMemberKeys: async () => memberKeys,
}));

const { db } = await import("../../src/db/index.js");
const { clearRegistry, connectionTag } = await import("../helpers/crm-registry.js");
const { pickFollowupCandidate, readFollowupState } = await import("../../src/lib/followup-queue.js");
const { readFollowupOwed } = await import("../../src/lib/followup-owed.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("claim-next under relationships: current_client", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const acting = `itest-checkin-${randomUUID()}`;
  const createdLeads: string[] = [];
  let campaignId = "";

  async function dueLead(p: { email?: string; human?: string | null } = {}): Promise<{ rowId: string; leadId: string; email: string; human: string | null }> {
    const human = p.human === undefined ? randomUUID() : p.human;
    const email = p.email ?? `${randomUUID()}@example.test`;
    const [lead] = (await db.execute(sql`
      INSERT INTO leads (name, human_id) VALUES (${"itest " + email}, ${human}::uuid) RETURNING id
    `)) as unknown as Array<{ id: string }>;
    createdLeads.push(lead.id);
    await db.execute(sql`
      INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${lead.id}::uuid, 'email', ${email}, 'itest')
      ON CONFLICT DO NOTHING`);
    const [row] = (await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at, followup_due_at, followup_count)
      VALUES (${lead.id}::uuid, ${campaignId}, ${orgId}, ${sql.param([brandId])}::text[], 'served', now(), now() - interval '1 minute', 0)
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    return { rowId: row.id, leadId: lead.id, email, human };
  }

  async function sale(leadId: string, p: { brand?: string; withdrawn?: boolean } = {}): Promise<void> {
    await db.execute(sql`
      INSERT INTO conversion_events (org_id, brand_id, event, match_confidence, attribution_status, matched_lead_id, source, value_cents, withdrawn_at)
      VALUES (${orgId}, ${p.brand ?? brandId}, 'sale', 'exact', 'attributed', ${leadId}::uuid, 'crm', 9900, ${p.withdrawn ? sql`now()` : sql`NULL`})`);
  }

  const claim = (relationships?: "pure_prospect" | "current_client" | "own_team") =>
    pickFollowupCandidate({
      orgId,
      campaignId,
      runId: randomUUID(),
      actingCampaignId: acting,
      context: { orgId },
      ...(relationships ? { relationships } : {}),
    });

  beforeEach(() => {
    campaignId = `itest-client-gate-${randomUUID()}`;
    memberKeys.clear();
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM followup_actions WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM followup_responders WHERE first_responder_campaign_id = ${acting}`);
    await db.execute(sql`DELETE FROM conversion_events WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM lead_contact_methods WHERE lead_id = ANY(${sql.param(createdLeads)}::uuid[])`);
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(createdLeads)}::uuid[])`);
    await clearRegistry(orgId);
    for (const t of ["relationship_subjects", "relationship_judgments"]) await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
  });

  it("hands out a paying customer (the booked stop does not hide a client) and refuses a prospect and a team member with a sale", async () => {
    const prospect = await dueLead();
    const member = await dueLead();
    await sale(member.leadId);
    memberKeys.add(member.email.toLowerCase());
    await new Promise((r) => setTimeout(r, 5));
    const customer = await dueLead();
    await db.execute(sql`UPDATE leads_campaigns SET followup_due_at = now() - interval '1 second' WHERE id = ${customer.rowId}::uuid`);
    await sale(customer.leadId);

    const r = await claim("current_client");
    expect(r.claimed?.id).toBe(customer.rowId);
    expect(r.relationships!.policy).toBe("current_client");
    expect(r.relationships!.refused.map((x) => [x.email, x.reason])).toEqual(
      expect.arrayContaining([
        [prospect.email.toLowerCase(), "not_a_client"],
        [member.email.toLowerCase(), "team_member"],
      ]),
    );
    expect(await readFollowupState(orgId, prospect.rowId)).toMatchObject({ dueAt: null, stoppedReason: "relationship_not_a_client" });
    expect(await readFollowupState(orgId, member.rowId)).toMatchObject({ dueAt: null, stoppedReason: "relationship_team_member" });
  });

  it("a sale on another lead of the same human counts; a sale of another brand or a withdrawn one does not", async () => {
    const human = randomUUID();
    const other = await dueLead({ human });
    await db.execute(sql`UPDATE leads_campaigns SET followup_due_at = NULL WHERE id = ${other.rowId}::uuid`);
    await sale(other.leadId);
    const sameHuman = await dueLead({ human });
    expect((await claim("current_client")).claimed?.id).toBe(sameHuman.rowId);

    campaignId = `itest-client-gate-${randomUUID()}`;
    const elsewhere = await dueLead();
    await sale(elsewhere.leadId, { brand: randomUUID() });
    const withdrawn = await dueLead();
    await sale(withdrawn.leadId, { withdrawn: true });
    const r = await claim("current_client");
    expect(r).toMatchObject({ claimed: null, reason: "relationship_refused" });
    expect(r.relationships!.refused.map((x) => x.reason)).toEqual(["not_a_client", "not_a_client"]);
  });

  it("refuses staff and a personal contact who paid", async () => {
    const staff = await dueLead({ email: `kevin.lourd+${randomUUID().slice(0, 8)}@gmail.com` });
    await sale(staff.leadId);
    const friend = await dueLead();
    await sale(friend.leadId);
    await connectionTag({ orgId, brandId, human: friend.human!, personKey: `email:${friend.email}`, tag: "personal_to_user" });

    const r = await claim("current_client");
    expect(r).toMatchObject({ claimed: null, reason: "relationship_refused" });
    expect(r.relationships!.refused.map((x) => [x.leadId, x.reason, x.tags])).toEqual(
      expect.arrayContaining([
        [staff.leadId, "staff", []],
        [friend.leadId, "personal", ["personal"]],
      ]),
    );
  });

  // DOCDINNERS-RELATIONSHIP-PENDING-1028: the per-human block shows the latest-active relation's tags; a team verdict on
  // the human's OTHER relation must refuse the check-in too.
  it("refuses a payer who is team on another relation than their latest-active one", async () => {
    const p = await dueLead();
    await sale(p.leadId);
    const low = { customer: 0.8, prospect: 0.1, team: 0.05, investor: 0.05, advisor: 0.05, supplier: 0.05, partner: 0.05, other_professional: 0.05, journalist: 0.05 };
    for (const [key, team, inbound] of [["", 0.8, sql`now() - interval '1 day'`], [randomUUID(), 0.05, sql`now()`]] as const) {
      await db.execute(sql`
        INSERT INTO relationship_subjects (org_id, brand_id, human_id, company_key, name, emails, thread_seq, has_messages, has_direct, last_inbound_at)
        VALUES (${orgId}, ${brandId}, ${p.human}::uuid, ${key}, 'itest', ${sql.param([p.email])}::text[], 1, true, true, ${inbound})`);
      await db.execute(sql`
        INSERT INTO relationship_judgments (org_id, brand_id, human_id, company_key, probabilities, thread_seq, model, run_id)
        VALUES (${orgId}, ${brandId}, ${p.human}::uuid, ${key}, ${JSON.stringify({ ...low, team })}::jsonb, 1, 'jev-test', 'run')`);
    }
    const r = await claim("current_client");
    expect(r.claimed).toBeNull();
    expect(r.relationships!.refused).toEqual([expect.objectContaining({ leadId: p.leadId, reason: "team_member", tags: ["team"] })]);
  });

  it("a paying customer with no human yet is pending, the row stays due", async () => {
    const p = await dueLead({ human: null });
    await sale(p.leadId);
    const r = await claim("current_client");
    expect(r).toMatchObject({ claimed: null, reason: "relationship_pending" });
    expect(r.relationships!.pending).toEqual([
      { leadCampaignId: p.rowId, leadId: p.leadId, campaignId, email: p.email.toLowerCase(), phone: null, reason: "human_unknown", retryAfterSeconds: 300 },
    ]);
    expect((await readFollowupState(orgId, p.rowId))!.dueAt).not.toBeNull();
  });

  // ONE-AI-CONVERSES-1029: the brand's own team is the third audience; whoever the two others refuse as staff/team.
  it("own_team hands out a member (with a sale: no booked stop) and staff, refuses a prospect and a client not_team", async () => {
    const prospect = await dueLead();
    const client = await dueLead();
    await sale(client.leadId);
    await new Promise((r) => setTimeout(r, 5));
    const member = await dueLead();
    await sale(member.leadId);
    memberKeys.add(member.email.toLowerCase());
    await db.execute(sql`UPDATE leads_campaigns SET followup_due_at = now() + interval '1 day' WHERE id = ${member.rowId}::uuid`);
    const staff = await dueLead({ email: `kevin.lourd+${randomUUID().slice(0, 8)}@gmail.com` });
    await db.execute(sql`UPDATE leads_campaigns SET followup_due_at = now() + interval '1 day' WHERE id = ${staff.rowId}::uuid`);

    const r = await claim("own_team");
    expect(r).toMatchObject({ claimed: null, reason: "relationship_refused" });
    expect(r.relationships!.policy).toBe("own_team");
    expect(r.relationships!.refused.map((x) => [x.leadId, x.reason])).toEqual(
      expect.arrayContaining([
        [prospect.leadId, "not_team"],
        [client.leadId, "not_team"],
      ]),
    );
    expect(await readFollowupState(orgId, client.rowId)).toMatchObject({ dueAt: null, stoppedReason: "relationship_not_team" });

    await db.execute(sql`UPDATE leads_campaigns SET followup_due_at = now() - interval '1 minute' WHERE id = ANY(${sql.param([member.rowId, staff.rowId])}::uuid[])`);
    const first = await claim("own_team");
    const second = await claim("own_team");
    expect([first.claimed?.id, second.claimed?.id].sort()).toEqual([member.rowId, staff.rowId].sort());
  });

  it("pure_prospect and no policy keep the booked stop for the same customer", async () => {
    const p = await dueLead();
    await sale(p.leadId);
    expect(await claim("pure_prospect")).toMatchObject({ claimed: null, reason: "nothing_due" });
    expect(await claim()).toMatchObject({ claimed: null, reason: "nothing_due" });
  });

  it("owed reads a customer an occurrence named as owed (a client check-in)", async () => {
    const p = await dueLead();
    await sale(p.leadId);
    const before = await readFollowupOwed({ orgId, query: { campaignId: acting, heldCampaignIds: [campaignId] }, nowMs: Date.now() });
    expect(before.owedNow).toBe(false);
    await db.execute(sql`
      UPDATE leads_campaigns SET followup_stated_event_id = ${randomUUID()}, followup_stated_at = now(), followup_stated_closed_at = NULL
      WHERE id = ${p.rowId}::uuid`);
    const after = await readFollowupOwed({ orgId, query: { campaignId: acting, heldCampaignIds: [campaignId] }, nowMs: Date.now() });
    expect(after.owedNow).toBe(true);
  });
});
