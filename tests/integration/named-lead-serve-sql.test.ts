/**
 * A serve that NAMES its person (LEAD-NAMED-SERVE-1015), against a REAL database: the person a trigger occurrence
 * filed on a campaign (fileNamedPerson, the door campaign-service calls) is handed out by the cold workflow's serve
 * (pullNext mode `named`) as that campaign's lead; a redelivered run of the same occurrence after a send is refused, one
 * after a run that failed before sending gets the person again; a person known only by an email is enriched once.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const CAMPAIGNS = new Map<string, string>();
vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchCampaign: async (id: string) =>
    CAMPAIGNS.has(id)
      ? { id, brandId: CAMPAIGNS.get(id), brandIds: null, featureSlug: "sales-cold-email-outreach", workflowSlug: "cold", offerId: null }
      : null,
}));
vi.mock("../../src/lib/brand-client.js", () => ({ getCurrentGoal: async () => "Book meetings" }));
vi.mock("../../src/lib/writer-checks.js", () => ({
  offerChecks: async () => [],
  checksForWriter: async () => ({ checks: [] }),
}));

// What the sender holds per address on the campaign (email-gateway, campaign scope).
const sender = new Map<string, { contacted: boolean; sent: boolean; queued: boolean; sentCount: number; unsubscribed?: boolean }>();
let gatewayDown = false;
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: async (_b: string, _c: string, items: Array<{ email: string }>) => {
    if (gatewayDown) throw new Error("email-gateway 503");
    return {
      results: items.map((i) => {
        const s = sender.get(i.email) ?? { contacted: false, sent: false, queued: false, sentCount: 0 };
        return {
          email: i.email,
          broadcast: {
            campaign: { contacted: s.contacted, sent: s.sent, queued: s.queued, finished: false, sentCount: s.sentCount },
            global: { email: { bounced: false, unsubscribed: Boolean(s.unsubscribed) } },
          },
        };
      }),
    };
  },
}));

// treg people.enrich (org-billed meter): answers per address.
const enrichAnswers = new Map<string, unknown>();
const enrichCalls: string[] = [];
vi.mock("../../src/lib/treg-client.js", () => ({
  TregMeter: class {
    async call(req: { params: { email: string } }) {
      enrichCalls.push(req.params.email);
      return { status: 200, body: enrichAnswers.get(req.params.email) ?? { output: {} }, chargedMicro: 2634, contentType: "application/json" };
    }
  },
}));

const { db } = await import("../../src/db/index.js");
const { sql } = await import("drizzle-orm");
const { fileNamedPerson } = await import("../../src/lib/named-person.js");
const { pullNext } = await import("../../src/lib/buffer.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("named serve against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const campaignId = randomUUID();
  const otherCampaignId = randomUUID();
  CAMPAIGNS.set(campaignId, brandId);
  CAMPAIGNS.set(otherCampaignId, brandId);
  const tag = randomUUID().slice(0, 8);
  const addr = (n: string) => `kevin+${n}-${tag}@distribute.you`;
  const leadIds: string[] = [];

  beforeEach(() => {
    gatewayDown = false;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM named_lead_serves WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM brand_person_statements WHERE org_id = ${orgId}`);
    if (leadIds.length) {
      const ids = sql.param(leadIds);
      await db.execute(sql`DELETE FROM named_lead_enrichments WHERE lead_id = ANY(${ids}::uuid[])`);
      await db.execute(sql`DELETE FROM leads_organizations WHERE lead_id = ANY(${ids}::uuid[])`);
      await db.execute(sql`DELETE FROM lead_contact_methods WHERE lead_id = ANY(${ids}::uuid[])`);
      await db.execute(sql`DELETE FROM leads WHERE id = ANY(${ids}::uuid[])`);
    }
  });

  async function file(email: string, fullName: string | null, eventId: string) {
    const r = await fileNamedPerson({ orgId, campaignId, email, statedBy: { triggerEventId: eventId }, fullName, runId: randomUUID() });
    if (!r.ok) throw new Error(`filing refused: ${r.code}`);
    leadIds.push(r.leadId);
    return r;
  }

  function serve(leadId: string, triggerEventId: string, campaign = campaignId) {
    return pullNext({
      orgId,
      campaignId: campaign,
      brandIds: [brandId],
      brandId,
      featureSlug: "sales-cold-email-outreach",
      runFeatureSlug: "sales-cold-email-outreach",
      runId: randomUUID(),
      parentRunId: randomUUID(),
      userId: randomUUID(),
      mode: { kind: "named", named: { leadId, triggerEventId } },
    });
  }

  it("hands out exactly the filed person, in the served shape, and re-points the row at the run", async () => {
    const ev = randomUUID();
    const filed = await file(addr("ann"), "Ann Example", ev);
    const res = await serve(filed.leadId, ev);
    expect(res.found).toBe(true);
    expect(res.lead).toMatchObject({ leadId: filed.leadId, email: addr("ann"), goal: "Book meetings", qualification: { checks: [] } });
    expect((res.lead!.data as { firstName: string }).firstName).toBe("Ann");
    const rows = (await db.execute(sql`
      SELECT serve_count, baseline_sent_count, baseline_contacted FROM named_lead_serves WHERE lead_id = ${filed.leadId}::uuid AND trigger_event_id = ${ev}
    `)) as unknown as Array<{ serve_count: number; baseline_sent_count: number; baseline_contacted: boolean }>;
    expect(rows).toEqual([{ serve_count: 1, baseline_sent_count: 0, baseline_contacted: false }]);
    expect(enrichCalls).not.toContain(addr("ann"));
  });

  it("a redelivered run after a run that failed before sending gets the person again; after a send it is refused for good", async () => {
    const ev = randomUUID();
    const filed = await file(addr("bob"), "Bob Example", ev);
    expect((await serve(filed.leadId, ev)).found).toBe(true);
    // The first run died before sending: the sender holds nothing new.
    expect((await serve(filed.leadId, ev)).found).toBe(true);
    // The second run sent.
    sender.set(addr("bob"), { contacted: true, sent: true, queued: false, sentCount: 1 });
    const third = await serve(filed.leadId, ev);
    expect(third).toMatchObject({ found: false, reason: "named_lead_already_worked", final: true });
    // A NEW occurrence naming the same person is not "already worked" (a new ask of the client).
    const next = await serve(filed.leadId, randomUUID());
    expect(next.found).toBe(true);
  });

  it("a person known only by an email is enriched once and served with what was found", async () => {
    const ev = randomUUID();
    const email = addr("nameless");
    const filed = await file(email, null, ev);
    enrichAnswers.set(email, { output: { full_name: "Cleo Example", first_name: "Cleo", last_name: "Example", title: "Head of Ops", company: "Example Co", company_domain: `example-${tag}.com` } });
    const res = await serve(filed.leadId, ev);
    expect(res.found).toBe(true);
    const data = res.lead!.data as { firstName: string; currentTitle: string | null; organization: { name: string | null } | null };
    expect(data.firstName).toBe("Cleo");
    expect(data.organization?.name).toBe("Example Co");
    expect(data.currentTitle).toBe("Head of Ops");
    // Redelivered: no second purchase.
    await serve(filed.leadId, ev);
    expect(enrichCalls.filter((e) => e === email)).toHaveLength(1);
  });

  it("an email nobody can put a name or company on is a final, readable refusal", async () => {
    const ev = randomUUID();
    const filed = await file(addr("ghost"), null, ev);
    const res = await serve(filed.leadId, ev);
    expect(res).toMatchObject({ found: false, reason: "named_lead_unwritable", final: true });
    expect(res.message).toMatch(/email address/);
  });

  it("not filed on this campaign, unsubscribed, and an unreadable sender are each named", async () => {
    const ev = randomUUID();
    const filed = await file(addr("cara"), "Cara Example", ev);
    expect(await serve(filed.leadId, ev, otherCampaignId)).toMatchObject({ found: false, reason: "named_lead_not_filed", final: true });

    gatewayDown = true;
    expect(await serve(filed.leadId, ev)).toMatchObject({ found: false, reason: "named_lead_sender_unreadable", final: false });
    gatewayDown = false;

    sender.set(addr("cara"), { contacted: false, sent: false, queued: false, sentCount: 0, unsubscribed: true });
    expect(await serve(filed.leadId, ev)).toMatchObject({ found: false, reason: "named_lead_suppressed", final: true });
  });
});
