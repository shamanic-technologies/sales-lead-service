/**
 * A statement a person makes is a fact about the PERSON at the brand, against a REAL database.
 *
 * One campaign as the customer knows it is often several stored rows for the same person
 * (campaign-service used to mint a new row on every workflow switch). A sale stated from one of
 * them must read as a sale on every one of them — the standing, the panel, the "never" guard —
 * and stating it again from another row must correct the one statement, never add a second deal.
 * The write resolves the prior statement inside one SQL statement (a subquery, a data-modifying
 * CTE), which a mocked `sql` compiles and never runs, so this file runs it.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

vi.mock("../../src/lib/campaign-leg-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/campaign-leg-client.js")>()),
  fetchOrgCampaignLegs: async () =>
    new Map([
      [CAMPAIGN_A, "start_to_conversation"],
      [CAMPAIGN_B, "start_to_conversation"],
    ]),
}));
vi.mock("../../src/lib/crm-cold-eligibility.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/crm-cold-eligibility.js")>()),
  loadCrmColdEligibility: async () => ({
    eligible: false,
    reason: "crm_never_paired",
    evidences: { meeting_booked: false, meeting_attended: false },
  }),
}));
vi.mock("../../src/lib/lead-cold-read.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/lead-cold-read.js")>()),
  readLeadRowCold: async () => ({
    wentCold: null,
    eligibility: { eligible: false, reason: "crm_never_paired" },
  }),
}));
// Nobody here has a measured click; the leads carry no email, so no gateway call is made anyway.
vi.mock("../../src/lib/measured-visits.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/measured-visits.js")>()),
  fetchMeasuredVisitEmails: async () => new Set<string>(),
}));

const CAMPAIGN_A = `itest-person-a-${randomUUID()}`;
const CAMPAIGN_B = `itest-person-b-${randomUUID()}`;

const { db } = await import("../../src/db/index.js");
const { sql } = await import("drizzle-orm");
const { leads, leadsCampaigns } = await import("../../src/db/schema.js");
const { createLeadStandingResolver } = await import("../../src/lib/lead-standing-resolver.js");
const stepStatementRoutes = (await import("../../src/routes/step-statements.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("a statement is about the person, not the row", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const app = express();
  app.use(express.json());
  app.use(stepStatementRoutes);

  const post = (rowId: string, body: object) =>
    request(app)
      .post(`/orgs/leads/${rowId}/step-statements`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", orgId)
      .set("x-user-id", "u1")
      .send(body);
  const get = (rowId: string) =>
    request(app)
      .get(`/orgs/leads/${rowId}/step-statements`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", orgId)
      .set("x-user-id", "u1");

  /** One person, two rows of the same brand: A skipped (where it was stated), B served (surfaced). */
  async function seedPerson() {
    const [lead] = await db.insert(leads).values({ firstName: "Pat", lastName: "Row" }).returning();
    const [a] = await db
      .insert(leadsCampaigns)
      .values({ leadId: lead.id, campaignId: CAMPAIGN_A, orgId, brandIds: [brandId], status: "skipped" })
      .returning();
    const [b] = await db
      .insert(leadsCampaigns)
      .values({ leadId: lead.id, campaignId: CAMPAIGN_B, orgId, brandIds: [brandId], status: "served" })
      .returning();
    return { leadId: lead.id, rowA: a.id, rowB: b.id };
  }

  async function standingOf(p: { leadId: string; rowB: string }) {
    const resolver = createLeadStandingResolver({ orgId, deliveryQueried: true } as never);
    const facts = await resolver.resolve([
      {
        id: p.rowB,
        leadId: p.leadId,
        campaignId: CAMPAIGN_B,
        brandIds: [brandId],
        status: "served",
        delivery: {
          contacted: true,
          opened: false,
          clicked: false,
          replied: false,
          replyClassification: null,
          firstRepliedAt: null,
          bounced: false,
          unsubscribed: false,
          globalBounced: false,
          globalUnsubscribed: false,
        },
      },
    ]);
    return facts.get(p.rowB)!;
  }

  async function liveManual(table: "outcomes" | "nevers", leadId: string, step: string) {
    const rows =
      table === "outcomes"
        ? await db.execute(sql`
            SELECT value_cents FROM conversion_events
            WHERE brand_id = ${brandId} AND matched_lead_id = ${leadId} AND event = ${step}
              AND source = 'manual' AND withdrawn_at IS NULL`)
        : await db.execute(sql`
            SELECT cost_cents FROM lead_step_disqualifications
            WHERE brand_id = ${brandId} AND lead_id = ${leadId} AND step = ${step}
              AND source = 'manual' AND withdrawn_at IS NULL AND retracted_at IS NULL`);
    return rows as unknown as Array<Record<string, number>>;
  }

  let won: Awaited<ReturnType<typeof seedPerson>>;

  beforeAll(async () => {
    won = await seedPerson();
  }, 60_000);

  it("a sale stated on row A reads as customer on row B, with the deal", async () => {
    const res = await post(won.rowA, { step: "sale", kind: "outcome", valueCents: 250000, costCents: 0 });
    expect(res.status).toBe(201);

    const facts = await standingOf(won);
    expect(facts.standing.state).toBe("customer");
    expect(facts.closedDeal).toMatchObject({ valueCents: 250000, source: "manual" });

    // The panel opened on row B knows the sale, so it never offers to state it again.
    const panel = await get(won.rowB);
    expect(panel.status).toBe(200);
    expect(panel.body.steps.find((s: { step: string }) => s.step === "sale")).toMatchObject({
      state: "outcome",
      origin: "stated",
      source: "manual",
    });
  });

  it("stating the sale again from row B corrects the one deal — never a second one", async () => {
    const res = await post(won.rowB, { step: "sale", kind: "outcome", valueCents: 300000, costCents: 0 });
    expect(res.status).toBe(201);

    const live = await liveManual("outcomes", won.leadId, "sale");
    expect(live).toHaveLength(1);
    expect(Number(live[0].value_cents)).toBe(300000);
  });

  it("a 'never' on row B is refused while the sale stated on row A stands", async () => {
    const res = await post(won.rowB, { step: "sale", kind: "never", costCents: 0 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("step_already_happened");
  });

  it("a 'never' stated on row A reads on row B, and restating it from B keeps one statement", async () => {
    const lost = await seedPerson();
    expect((await post(lost.rowA, { step: "sale", kind: "never", costCents: 100 })).status).toBe(201);

    expect((await standingOf(lost)).standing.state).toBe("disqualified");

    expect((await post(lost.rowB, { step: "sale", kind: "never", costCents: 200 })).status).toBe(201);
    const live = await liveManual("nevers", lost.leadId, "sale");
    expect(live).toHaveLength(1);
    expect(Number(live[0].cost_cents)).toBe(200);

    // An outcome stated from row B retracts the "never" stated from row A: the fact contradicts it.
    const outcome = await post(lost.rowB, {
      step: "sale",
      kind: "outcome",
      valueCents: 5000,
      costCents: 0,
    });
    expect(outcome.status).toBe(201);
    expect(outcome.body.retractedNeverSteps).toContain("sale");
    expect(await liveManual("nevers", lost.leadId, "sale")).toHaveLength(0);
    expect((await standingOf(lost)).standing.state).toBe("customer");

    // Withdrawing it from row A (not the row it was stated from) takes it back and restores the never.
    const withdrawn = await request(app)
      .delete(`/orgs/leads/${lost.rowA}/step-statements/sale`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", orgId)
      .set("x-user-id", "u1");
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.restoredNeverSteps).toContain("sale");
    expect((await standingOf(lost)).standing.state).toBe("disqualified");
  });
});
