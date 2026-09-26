/**
 * What the customer's own CRM evidences, reflected onto paired leads — executed against a REAL
 * database. The siblings (crm-service, email-gateway, campaign-service) are mocked; every statement
 * this feature writes or reads is raw `sql` and runs for real here, because a mocked `sql` compiles
 * none of it (the `sql.param` array rule exists because that shipped green twice).
 *
 * What it proves:
 *   - only a PAIRED contact's evidence lands; an unconfirmed pairing writes nothing
 *   - whose win follows the date rule against our first delivered email, and an undated event is
 *     never ours
 *   - the lead then reads customer, with a closed deal whose source is `crm`, through the SAME
 *     resolver every list read uses
 *   - a CRM "never" lands per campaign row and reads as a never
 *   - a person's own statement of the step outranks the CRM (the CRM row is set aside, never both)
 *   - a person's whose-win override is honoured by the sync, and rejecting the pairing sets every
 *     CRM row aside on the next pass
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const state = vi.hoisted(() => ({
  contacts: [] as Array<{
    contactId: string;
    primaryEmail: string | null;
    fullName: string | null;
    events: Array<Record<string, unknown>>;
  }>,
  delivered: new Map<string, string | null>(),
  legByCampaign: new Map<string, string>(),
}));

vi.mock("../../src/lib/crm-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/crm-client.js")>();
  return {
    ...actual,
    fetchCrmFunnelEvents: vi.fn(async () => state.contacts),
    // eslint-disable-next-line require-yield
    streamCrmContacts: vi.fn(async function* () {
      return;
    }),
    fetchCrmOpportunitiesByContact: vi.fn(async () => new Map()),
  };
});

vi.mock("../../src/lib/email-gateway-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/email-gateway-client.js")>();
  return {
    ...actual,
    checkDeliveryStatus: vi.fn(async (_b: string, _c: unknown, items: Array<{ email: string }>) => ({
      results: items.map(({ email }) => {
        const at = state.delivered.get(email) ?? null;
        return {
          email,
          broadcast: {
            brand: at
              ? {
                  contacted: true,
                  sent: true,
                  delivered: true,
                  firstContactedAt: at,
                  firstSentAt: at,
                  firstDeliveredAt: at,
                }
              : null,
          },
        };
      }),
    })),
  };
});

vi.mock("../../src/lib/campaign-leg-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/campaign-leg-client.js")>();
  return {
    ...actual,
    fetchOrgCampaignLegs: vi.fn(async () => new Map(state.legByCampaign)),
  };
});

const { db } = await import("../../src/db/index.js");
const { sql } = await import("drizzle-orm");
const { leads, leadsCampaigns, leadContactMethods } = await import("../../src/db/schema.js");
const { freezeMatches, upsertRuling } = await import("../../src/lib/crm-pairing-store.js");
const { syncCrmEvidence } = await import("../../src/lib/crm-evidence-sync.js");
const { supersedeCrmOutcome, upsertCauseStatement, withdrawCauseStatement } = await import(
  "../../src/lib/crm-evidence-store.js"
);
const { createLeadStandingResolver } = await import("../../src/lib/lead-standing-resolver.js");
const { DEFAULT_STATUS } = await import("../../src/lib/delivery-flatten.js");
const { standingDelivery } = await import("../../src/lib/lead-standing-index.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("CRM evidence sync against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const campaignA = `itest-crm-ev-a-${randomUUID()}`;
  const campaignB = `itest-crm-ev-b-${randomUUID()}`;

  const ids: Record<string, { leadId: string; rows: string[]; email: string }> = {};

  async function seedLead(key: string, campaigns: string[]) {
    const email = `${key}-${randomUUID().slice(0, 8)}@example.com`;
    const [lead] = await db
      .insert(leads)
      .values({ firstName: key, lastName: "Test", name: `${key} Test` })
      .returning();
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: email, source: "test" });
    const rows: string[] = [];
    for (const campaignId of campaigns) {
      const [row] = await db
        .insert(leadsCampaigns)
        .values({
          leadId: lead.id,
          campaignId,
          orgId,
          userId: "u1",
          brandIds: [brandId],
          status: "served",
          servedAt: new Date(),
        })
        .returning();
      rows.push(row.id);
    }
    ids[key] = { leadId: lead.id, rows, email };
  }

  async function pair(contactId: string, leadId: string, confidence: "deterministic" | "probabilistic") {
    await freezeMatches(orgId, brandId, [
      {
        crmContactId: contactId,
        result: {
          matchedLeadId: leadId,
          matchMethod: confidence === "deterministic" ? "email" : "last_name",
          matchConfidence: confidence,
          attributionStatus: "attributed",
          candidateCount: confidence === "deterministic" ? 1 : 3,
          candidates: [{ leadId }],
        },
      },
    ]);
  }

  function sale(occurredAt: string | null, sourceId = "opp-1") {
    return {
      step: "sale",
      occurredAt,
      dateBasis: "status_changed_at",
      source: "won_status",
      sourceId,
      detail: null,
    };
  }

  async function crmOutcomes(leadId: string) {
    return (await db.execute(sql`
      SELECT event, caused_by_outreach, received_at, withdrawn_at, lead_campaign_id, crm_evidence
      FROM conversion_events
      WHERE brand_id = ${brandId} AND matched_lead_id = ${leadId} AND source = 'crm'
    `)) as unknown as Array<{
      event: string;
      caused_by_outreach: boolean | null;
      received_at: unknown;
      withdrawn_at: unknown;
      lead_campaign_id: string | null;
      crm_evidence: { rule?: { reason: string } };
    }>;
  }

  beforeAll(async () => {
    await seedLead("after", [campaignA]);
    await seedLead("before", [campaignA]);
    await seedLead("undated", [campaignA]);
    await seedLead("unsure", [campaignA]);
    await seedLead("noshow", [campaignA, campaignB]);
    await seedLead("stated", [campaignA]);
    state.legByCampaign.set(campaignA, "start_to_conversation");
    state.legByCampaign.set(campaignB, "start_to_conversation");

    for (const key of ["after", "before", "undated", "noshow", "stated"]) {
      await pair(`c-${key}`, ids[key].leadId, "deterministic");
      state.delivered.set(ids[key].email, "2026-05-11T00:00:00.000Z");
    }
    await pair("c-unsure", ids.unsure.leadId, "probabilistic");

    state.contacts = [
      { contactId: "c-after", primaryEmail: null, fullName: null, events: [
        { step: "meeting_booked", occurredAt: "2025-04-01T00:00:00.000Z", dateBasis: "booked_at", source: "appointment", sourceId: "ap1", detail: null },
        sale("2026-05-20T00:00:00.000Z"),
        sale("2026-05-14T00:00:00.000Z"),
      ] },
      { contactId: "c-before", primaryEmail: null, fullName: null, events: [sale("2026-05-01T00:00:00.000Z")] },
      { contactId: "c-undated", primaryEmail: null, fullName: null, events: [sale(null)] },
      { contactId: "c-unsure", primaryEmail: null, fullName: null, events: [sale("2026-06-01T00:00:00.000Z")] },
      { contactId: "c-noshow", primaryEmail: null, fullName: null, events: [
        { step: "meeting_not_held", occurredAt: "2026-06-02T00:00:00.000Z", dateBasis: "scheduled_start", source: "appointment", sourceId: "ap9", detail: null },
      ] },
      { contactId: "c-stated", primaryEmail: null, fullName: null, events: [sale("2026-06-03T00:00:00.000Z")] },
    ];

    // A person already stated the sale for "stated" — theirs outranks the CRM.
    await db.execute(sql`
      INSERT INTO conversion_events (
        brand_id, org_id, event, dedupe_signature, value_cents, cost_cents, matched_lead_id,
        match_method, match_confidence, attribution_status, candidate_count, received_at, source,
        campaign_id, lead_campaign_id
      ) VALUES (
        ${brandId}, ${orgId}, 'sale', ${`m:${ids.stated.rows[0]}:sale`}, 5000, 0, ${ids.stated.leadId},
        'manual', 'deterministic', 'attributed', 1, ${"2026-06-04T00:00:00.000Z"}, 'manual',
        ${campaignA}, ${ids.stated.rows[0]}
      )
    `);
  }, 60_000);

  it("reflects only paired evidence, with whose-win following the date rule", async () => {
    const result = await syncCrmEvidence(orgId, brandId);
    expect(result.pairedContacts).toBe(5);

    const after = await crmOutcomes(ids.after.leadId);
    const afterSale = after.find((r) => r.event === "sale")!;
    // The EARLIEST dated sale stands for the step.
    expect(new Date(afterSale.received_at as string).toISOString()).toBe("2026-05-14T00:00:00.000Z");
    expect(afterSale.caused_by_outreach).toBe(true);
    expect(afterSale.lead_campaign_id).toBeNull();
    // Booked in 2025, before our first email: not ours.
    expect(after.find((r) => r.event === "meeting_booked")!.caused_by_outreach).toBe(false);

    expect((await crmOutcomes(ids.before.leadId))[0].caused_by_outreach).toBe(false);

    const undated = (await crmOutcomes(ids.undated.leadId))[0];
    expect(undated.caused_by_outreach).toBeNull();
    expect(undated.received_at).toBeNull();
    expect(undated.crm_evidence.rule?.reason).toBe("event_undated");

    expect(await crmOutcomes(ids.unsure.leadId)).toHaveLength(0);
    expect(await crmOutcomes(ids.stated.leadId)).toHaveLength(0);
  });

  it("reads the paired lead as a customer with a CRM closed deal, through the shared resolver", async () => {
    const resolver = createLeadStandingResolver({ orgId, deliveryQueried: true });
    const facts = await resolver.resolve([
      {
        id: ids.after.rows[0],
        leadId: ids.after.leadId,
        campaignId: campaignA,
        brandIds: [brandId],
        status: "served",
        delivery: standingDelivery({ ...DEFAULT_STATUS, contacted: true, sent: true, delivered: true }),
      },
    ]);
    const f = facts.get(ids.after.rows[0])!;
    expect(f.standing.state).toBe("customer");
    expect(f.closedDeal).toMatchObject({ source: "crm", causedByOutreach: true });
  });

  it("writes a CRM never on every campaign row of the person", async () => {
    const rows = (await db.execute(sql`
      SELECT campaign_id, step, source, withdrawn_at FROM lead_step_disqualifications
      WHERE lead_id = ${ids.noshow.leadId}
    `)) as unknown as Array<{ campaign_id: string; step: string; source: string; withdrawn_at: unknown }>;
    expect(rows.map((r) => r.campaign_id).sort()).toEqual([campaignA, campaignB].sort());
    expect(rows.every((r) => r.step === "meeting_attended" && r.source === "crm" && !r.withdrawn_at)).toBe(true);
  });

  it("honours a person's whose-win override, and withdrawing it restores the rule", async () => {
    await upsertCauseStatement({
      orgId, brandId, leadId: ids.before.leadId, step: "sale", causedByOutreach: true, note: null, statedByUserId: "u1",
    });
    await syncCrmEvidence(orgId, brandId);
    expect((await crmOutcomes(ids.before.leadId))[0].caused_by_outreach).toBe(true);

    await withdrawCauseStatement(brandId, ids.before.leadId, "sale", "u1");
    await syncCrmEvidence(orgId, brandId);
    expect((await crmOutcomes(ids.before.leadId))[0].caused_by_outreach).toBe(false);
  });

  it("sets a CRM outcome aside when a person states the step, and stands it back up when they withdraw", async () => {
    await supersedeCrmOutcome(brandId, ids.after.leadId, "sale");
    let sale = (await crmOutcomes(ids.after.leadId)).find((r) => r.event === "sale")!;
    expect(sale.withdrawn_at).not.toBeNull();

    // No statement actually stands for it, so the next pass stands it back up.
    await syncCrmEvidence(orgId, brandId);
    sale = (await crmOutcomes(ids.after.leadId)).find((r) => r.event === "sale")!;
    expect(sale.withdrawn_at).toBeNull();
  });

  it("sets every CRM row of a pairing aside once a person rejects the pairing", async () => {
    await upsertRuling({
      orgId, brandId, crmContactId: "c-noshow", leadId: ids.noshow.leadId, ruling: "rejected", note: null, statedByUserId: "u1",
    });
    await upsertRuling({
      orgId, brandId, crmContactId: "c-after", leadId: ids.after.leadId, ruling: "rejected", note: null, statedByUserId: "u1",
    });
    const result = await syncCrmEvidence(orgId, brandId);
    expect(result.withdrawnNevers).toBe(2);
    expect((await crmOutcomes(ids.after.leadId)).every((r) => r.withdrawn_at !== null)).toBe(true);
  });
});
