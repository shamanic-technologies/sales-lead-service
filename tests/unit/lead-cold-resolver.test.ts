import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const execute = vi.fn();
vi.mock("../../src/db/index.js", () => ({
  db: { execute: (...args: unknown[]) => execute(...args) },
}));

const fetchOrgCampaignFunnelKeys = vi.fn();
vi.mock("../../src/lib/campaign-funnel-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/campaign-funnel-client.js")>();
  return {
    ...actual,
    fetchOrgCampaignFunnelKeys: (...args: unknown[]) => fetchOrgCampaignFunnelKeys(...args),
  };
});

const loadCrmColdEligibility = vi.fn();
const loadUnconfirmedPairingLeads = vi.fn();
vi.mock("../../src/lib/crm-cold-eligibility.js", () => ({
  loadCrmColdEligibility: (...args: unknown[]) => loadCrmColdEligibility(...args),
  loadUnconfirmedPairingLeads: (...args: unknown[]) => loadUnconfirmedPairingLeads(...args),
}));

import { createLeadStandingResolver, type StandingRow } from "../../src/lib/lead-standing-resolver.js";
import { CRM_COLD_INELIGIBLE } from "../../src/lib/lead-cold.js";

const dialect = new PgDialect();
const sqlOf = (call: unknown) => dialect.sqlToQuery(call as SQL).sql.toLowerCase();

const USABLE = { eligible: true, reason: null, evidences: { meeting_booked: true, meeting_attended: true } };

let outcomeRows: unknown[] = [];

function row(overrides: Partial<StandingRow> = {}): StandingRow {
  return {
    id: "row-1",
    leadId: "lead-1",
    campaignId: "camp-1",
    brandIds: ["brand-1"],
    status: "served",
    delivery: {
      contacted: true,
      opened: true,
      clicked: false,
      replied: true,
      replyClassification: "positive",
      firstRepliedAt: "2026-06-01T00:00:00.000Z",
      bounced: false,
      unsubscribed: false,
      globalBounced: false,
      globalUnsubscribed: false,
    },
    ...overrides,
  };
}

function resolver() {
  return createLeadStandingResolver({
    orgId: "org-1",
    userId: null,
    runId: null,
    brandId: "brand-1",
    deliveryQueried: true,
  });
}

beforeEach(() => {
  outcomeRows = [];
  execute.mockReset().mockImplementation(async (q: unknown) =>
    sqlOf(q).includes("from conversion_events") ? outcomeRows : [],
  );
  fetchOrgCampaignFunnelKeys
    .mockReset()
    .mockResolvedValue(new Map([["camp-1", "sales_meetings_from_conversation"]]));
  loadCrmColdEligibility.mockReset().mockResolvedValue(USABLE);
  loadUnconfirmedPairingLeads.mockReset().mockResolvedValue(new Set());
});

describe("standing.wentCold — resolved in the same pass as the standing", () => {
  it("a positive reply months ago with no meeting reads cold at meeting_booked, standing unchanged", async () => {
    const facts = (await resolver().resolve([row()])).get("row-1")!;
    expect(facts.standing.state).toBe("sales_interest");
    expect(facts.standing.wentCold).toMatchObject({
      step: "meeting_booked",
      after: "positive_reply",
      stalledSince: "2026-06-01T00:00:00.000Z",
    });
    expect(loadCrmColdEligibility).toHaveBeenCalledWith("org-1", "brand-1");
  });

  it("the CRM's positive reply dates the reply when the delivery layer holds none", async () => {
    outcomeRows = [
      {
        lead_campaign_id: null,
        matched_lead_id: "lead-1",
        event: "positive_reply",
        source: "crm",
        value_cents: null,
        cost_cents: null,
        caused_by_outreach: null,
        note: null,
        stated_by_user_id: null,
        received_at: "2026-07-01 00:00:00+00",
      },
    ];
    const r = row({
      delivery: { ...row().delivery, replied: false, replyClassification: null, firstRepliedAt: null },
    });
    const facts = (await resolver().resolve([r])).get("row-1")!;
    expect(facts.standing.wentCold?.stalledSince).toBe("2026-07-01T00:00:00.000Z");
  });

  it("a booked meeting not attended reads cold at meeting_attended; attended reads nothing", async () => {
    const booked = {
      lead_campaign_id: null,
      matched_lead_id: "lead-1",
      event: "meeting_booked",
      source: "crm",
      value_cents: null,
      cost_cents: null,
      caused_by_outreach: null,
      note: null,
      stated_by_user_id: null,
      received_at: "2026-07-09 13:34:22+00",
    };
    outcomeRows = [booked];
    let facts = (await resolver().resolve([row()])).get("row-1")!;
    expect(facts.standing.wentCold?.step).toBe("meeting_attended");

    outcomeRows = [booked, { ...booked, event: "meeting_attended", source: "manual", received_at: "2026-09-26 06:51:11+00" }];
    facts = (await resolver().resolve([row()])).get("row-1")!;
    expect(facts.standing.wentCold).toBeNull();
  });

  it("a brand with no usable CRM: nothing goes cold, and no pairing is read", async () => {
    loadCrmColdEligibility.mockResolvedValue(CRM_COLD_INELIGIBLE("no_crm_connection"));
    const facts = (await resolver().resolve([row()])).get("row-1")!;
    expect(facts.standing.wentCold).toBeNull();
    expect(loadUnconfirmedPairingLeads).not.toHaveBeenCalled();
  });

  it("a lead with an unconfirmed CRM pairing is held back", async () => {
    loadUnconfirmedPairingLeads.mockResolvedValue(new Set(["lead-1"]));
    const facts = (await resolver().resolve([row()])).get("row-1")!;
    expect(facts.standing.wentCold).toBeNull();
  });

  it("asks each brand's CRM once per resolver, not once per chunk", async () => {
    const r = resolver();
    await r.resolve([row()]);
    await r.resolve([row({ id: "row-2", leadId: "lead-2" })]);
    expect(loadCrmColdEligibility).toHaveBeenCalledTimes(1);
  });
});
