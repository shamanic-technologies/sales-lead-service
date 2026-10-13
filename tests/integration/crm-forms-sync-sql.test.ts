/**
 * CRM contacts paired by human-service's humanId (no matcher, no judgment since LEAD-REFONTE-1013),
 * and a form their prospect submitted counting as a positive reply — executed against a REAL
 * database. The siblings (crm-service, email-gateway, campaign-service) are mocked; every statement
 * is raw `sql` and runs for real here.
 *
 * What it proves:
 *   - a contact whose human is the lead's carries its CRM evidence; one whose human holds no lead
 *     carries none, and no judgment is ever bought
 *   - a form dated after our first delivered email is a positive reply on the lead (ledger, bucket,
 *     standing); one dated before is not; a prospect who filled it before AND after answered us the
 *     second time
 *   - a person rejecting a pairing removes everything it contributed on the next pass
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  funnelContacts: [] as Array<{
    contactId: string;
    humanId?: string | null;
    primaryEmail: string | null;
    fullName: string | null;
    events: Array<Record<string, unknown>>;
  }>,
  contacts: [] as Array<Record<string, unknown>>,
  delivered: new Map<string, string | null>(),
  legByCampaign: new Map<string, string>(),
}));

// The funnel events the sync reads (off the fact-feed copy since crm-fact-events.ts).
vi.mock("../../src/lib/crm-fact-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/crm-fact-events.js")>()),
  loadCrmFunnelEvents: vi.fn(async () => state.funnelContacts),
}));

vi.mock("../../src/lib/crm-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/crm-client.js")>();
  return {
    ...actual,
    streamCrmContacts: vi.fn(async function* () {
      yield state.contacts.map((c) => actual.normalizeCrmContact(c as never));
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
              ? { contacted: true, sent: true, delivered: true, firstContactedAt: at, firstSentAt: at, firstDeliveredAt: at }
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
const { upsertRuling } = await import("../../src/lib/crm-pairing-store.js");
const { syncCrmEvidence } = await import("../../src/lib/crm-evidence-sync.js");
const { fetchOutcomesByLead } = await import("../../src/lib/lead-index.js");
const { bucketsForRow } = await import("../../src/lib/lead-buckets.js");
const { createLeadStandingResolver } = await import("../../src/lib/lead-standing-resolver.js");
const { DEFAULT_STATUS } = await import("../../src/lib/delivery-flatten.js");
const { standingDelivery } = await import("../../src/lib/lead-standing-index.js");
const conversionsRoutes = (await import("../../src/routes/conversions.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("CRM judging + form-as-positive-reply against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const campaign = `itest-crm-judge-${randomUUID()}`;
  const FIRST_EMAIL = "2026-05-11T00:00:00.000Z";
  const ids: Record<string, { leadId: string; row: string; email: string }> = {};

  async function seedLead(key: string) {
    const email = `${key}-${randomUUID().slice(0, 8)}@example.com`;
    const [lead] = await db
      .insert(leads)
      .values({ firstName: "Pat", lastName: key, name: `Pat ${key}` })
      .returning();
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: email, source: "test" });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({ leadId: lead.id, campaignId: campaign, orgId, userId: "u1", brandIds: [brandId], status: "served", servedAt: new Date() })
      .returning();
    ids[key] = { leadId: lead.id, row: row.id, email };
    state.delivered.set(email, FIRST_EMAIL);
  }

  // human-service's answer: contact c-<key> IS this lead's human (crm-service states the humanId).
  const humanOfContact = new Map<string, string>();
  async function pairByHumanId(key: string) {
    const humanId = randomUUID();
    await db.execute(sql`UPDATE leads SET human_id = ${humanId}::uuid WHERE id = ${ids[key].leadId}::uuid`);
    humanOfContact.set(`c-${key}`, humanId);
  }

  function form(occurredAt: string | null, source = "form_submission") {
    return { step: "form_submitted", occurredAt, dateBasis: "submitted_at", source, sourceId: randomUUID(), detail: null };
  }

  async function crmRows(key: string) {
    return (await db.execute(sql`
      SELECT event, caused_by_outreach, received_at, withdrawn_at
      FROM conversion_events
      WHERE brand_id = ${brandId} AND matched_lead_id = ${ids[key].leadId} AND source = 'crm'
    `)) as unknown as Array<{ event: string; caused_by_outreach: boolean | null; received_at: unknown; withdrawn_at: unknown }>;
  }

  const KEYS = ["maybe", "no", "formafter", "formbefore", "formboth"];

  beforeAll(async () => {
    for (const key of KEYS) {
      await seedLead(key);
      // "no": its contact's human is somebody else (never one of our leads).
      if (key === "no") humanOfContact.set("c-no", randomUUID());
      else await pairByHumanId(key);
    }
    state.legByCampaign.set(campaign, "start_to_conversation");
    state.contacts = KEYS.map((key) => ({
      id: `c-${key}`,
      brandId,
      externalId: key,
      primaryEmail: null,
      phoneE164: null,
      fullName: `P. ${key}`,
      firstName: "P.",
      lastName: key,
      unsubscribed: false,
    }));
    const sale = { step: "sale", occurredAt: "2026-06-01T00:00:00.000Z", dateBasis: "status_changed_at", source: "won_status", sourceId: "opp", detail: null };
    state.funnelContacts = [
      { contactId: "c-maybe", primaryEmail: null, fullName: null, events: [sale] },
      { contactId: "c-no", primaryEmail: null, fullName: null, events: [sale] },
      { contactId: "c-formafter", primaryEmail: null, fullName: null, events: [form("2026-05-20T00:00:00.000Z")] },
      { contactId: "c-formbefore", primaryEmail: null, fullName: null, events: [form("2026-05-01T00:00:00.000Z", "form_origin")] },
      {
        contactId: "c-formboth",
        primaryEmail: null,
        fullName: null,
        events: [form("2026-05-01T00:00:00.000Z"), form("2026-05-25T00:00:00.000Z"), form("2026-05-15T00:00:00.000Z")],
      },
    ];
    for (const c of state.funnelContacts) c.humanId = humanOfContact.get(c.contactId) ?? null;
  }, 60_000);

  it("pairs by humanId only and buys no judgment", async () => {
    const result = await syncCrmEvidence(orgId, brandId);
    expect(result.judging).toMatchObject({ judged: 0, judgmentFailed: 0 });
    expect(result).toMatchObject({ pairedByHuman: 4, neededMatcher: 0 });
  });

  it("a contact whose human is the lead's carries its CRM evidence; one whose human is not carries none", async () => {
    expect((await crmRows("maybe")).find((r) => r.event === "sale")).toMatchObject({ withdrawn_at: null });
    expect(await crmRows("no")).toHaveLength(0);
  });

  it("a form after our first email is a positive reply; before it is not; before AND after answered us the second time", async () => {
    const after = (await crmRows("formafter")).find((r) => r.event === "positive_reply")!;
    expect(after.caused_by_outreach).toBe(true);
    expect(new Date(after.received_at as string).toISOString()).toBe("2026-05-20T00:00:00.000Z");

    expect((await crmRows("formbefore")).filter((r) => r.event === "positive_reply")).toHaveLength(0);

    const both = (await crmRows("formboth")).find((r) => r.event === "positive_reply")!;
    expect(new Date(both.received_at as string).toISOString()).toBe("2026-05-15T00:00:00.000Z");
  });

  it("the ledger's positive reply reaches the Leads bucket and the standing, the before-form does not", async () => {
    const outcomes = await fetchOutcomesByLead(orgId, brandId, [ids.formafter.leadId, ids.formbefore.leadId]);
    const contactedOnly = { ...DEFAULT_STATUS, contacted: true, sent: true, delivered: true };
    const bucketsAfter = bucketsForRow(contactedOnly, outcomes.get(ids.formafter.leadId)!.steps, outcomes.get(ids.formafter.leadId)!.positiveReply === true);
    expect(bucketsAfter.has("positive_reply")).toBe(true);
    expect(outcomes.get(ids.formbefore.leadId)?.positiveReply ?? false).toBe(false);

    const resolver = createLeadStandingResolver({ orgId, deliveryQueried: true });
    const facts = await resolver.resolve(
      ["formafter", "formbefore"].map((key) => ({
        id: ids[key].row,
        leadId: ids[key].leadId,
        campaignId: campaign,
        brandIds: [brandId],
        status: "served",
        delivery: standingDelivery(contactedOnly),
      })),
    );
    expect(facts.get(ids.formafter.row)!.standing).toMatchObject({ state: "sales_interest", signal: "positive_reply" });
    expect(facts.get(ids.formbefore.row)!.standing.state).not.toBe("sales_interest");
  });

  it("serves the ledger's positive replies one row at a time on /converted-leads?event=positive_reply", async () => {
    const app = express();
    app.use(conversionsRoutes);
    const res = await request(app)
      .get(`/internal/brands/${brandId}/converted-leads?event=positive_reply`)
      .set("x-api-key", "test-api-key");
    expect([res.status, res.body]).toEqual([200, expect.objectContaining({ event: "positive_reply" })]);
    const byLead = new Map(res.body.outcomes.map((o: { leadId: string }) => [o.leadId, o]));
    expect(byLead.size).toBe(2);
    expect(byLead.get(ids.formafter.leadId)).toMatchObject({
      email: ids.formafter.email.toLowerCase(),
      occurredAt: "2026-05-20T00:00:00.000Z",
      source: "crm",
      causedByOutreach: true,
    });
    expect(byLead.has(ids.formboth.leadId)).toBe(true);
    expect(byLead.has(ids.formbefore.leadId)).toBe(false);
    // Still a 400 for anything that is neither a step nor the ledger's positive reply.
    const bad = await request(app)
      .get(`/internal/brands/${brandId}/converted-leads?event=reply`)
      .set("x-api-key", "test-api-key");
    expect(bad.status).toBe(400);
  });

  it("a person rejecting a pairing removes everything it contributed", async () => {
    await upsertRuling({
      orgId, brandId, crmContactId: "c-maybe", leadId: ids.maybe.leadId, ruling: "rejected", note: "not them", statedByUserId: "u1",
    });
    await upsertRuling({
      orgId, brandId, crmContactId: "c-formafter", leadId: ids.formafter.leadId, ruling: "rejected", note: null, statedByUserId: "u1",
    });
    await syncCrmEvidence(orgId, brandId);
    expect((await crmRows("maybe")).every((r) => r.withdrawn_at !== null)).toBe(true);
    expect((await crmRows("formafter")).every((r) => r.withdrawn_at !== null)).toBe(true);
    const outcomes = await fetchOutcomesByLead(orgId, brandId, [ids.formafter.leadId]);
    expect(outcomes.get(ids.formafter.leadId)?.positiveReply ?? false).toBe(false);
  });
});
