import { describe, it, expect } from "vitest";
import {
  dedupeSourceRows,
  pickStubLeadFields,
  buildMembershipValue,
  type SourceRow,
} from "../../scripts/backfill-historical-leads.js";

function row(over: Partial<SourceRow> = {}): SourceRow {
  return {
    campaignId: "c1",
    instantlyCampaignId: "ic1",
    email: "A@X.com",
    orgId: "o1",
    brandIds: ["b1"],
    workflowSlug: "sales-cold-email-outreach-tectonic",
    featureSlug: "sales-cold-email-outreach",
    createdAt: new Date("2026-04-24T00:03:45.383Z"),
    firstName: "Jc",
    lastName: "Doe",
    companyName: "MFG",
    ...over,
  };
}

describe("dedupeSourceRows", () => {
  it("collapses duplicate (email, campaign) pairs case-insensitively, first row wins", () => {
    const { pairs } = dedupeSourceRows([
      row({ email: "a@x.com", campaignId: "c1", instantlyCampaignId: "first" }),
      row({ email: "A@X.com", campaignId: "c1", instantlyCampaignId: "second" }),
      row({ email: "a@x.com", campaignId: "c2" }),
    ]);
    expect(pairs).toHaveLength(2);
    const c1 = pairs.find((p) => p.campaignId === "c1")!;
    expect(c1.emailLower).toBe("a@x.com");
    expect(c1.row.instantlyCampaignId).toBe("first");
    expect(pairs.map((p) => p.campaignId).sort()).toEqual(["c1", "c2"]);
  });

  it("returns distinct lowercased email set", () => {
    const { distinctEmails } = dedupeSourceRows([
      row({ email: "A@X.com", campaignId: "c1" }),
      row({ email: "a@x.com", campaignId: "c2" }),
      row({ email: "B@Y.com", campaignId: "c1" }),
    ]);
    expect(distinctEmails.sort()).toEqual(["a@x.com", "b@y.com"]);
  });

  it("drops rows with null/empty/whitespace email", () => {
    const { pairs, distinctEmails } = dedupeSourceRows([
      row({ email: null }),
      row({ email: "" }),
      row({ email: "   " }),
    ]);
    expect(pairs).toHaveLength(0);
    expect(distinctEmails).toHaveLength(0);
  });
});

describe("pickStubLeadFields", () => {
  it("trims names and composes full name", () => {
    expect(pickStubLeadFields(row({ firstName: " Jc ", lastName: " Doe " }))).toEqual({
      firstName: "Jc",
      lastName: "Doe",
      name: "Jc Doe",
    });
  });

  it("null name when both parts absent", () => {
    expect(pickStubLeadFields(row({ firstName: null, lastName: "" }))).toEqual({
      firstName: null,
      lastName: null,
      name: null,
    });
  });

  it("composes from a single available part", () => {
    expect(pickStubLeadFields(row({ firstName: "Jc", lastName: null })).name).toBe("Jc");
  });
});

describe("buildMembershipValue", () => {
  it("produces a served, reversible, feature-scoped membership backdated to send time", () => {
    const { pairs } = dedupeSourceRows([row()]);
    const v = buildMembershipValue(pairs[0], "lead-123");
    expect(v).toMatchObject({
      leadId: "lead-123",
      campaignId: "c1",
      orgId: "o1",
      brandIds: ["b1"],
      status: "served",
      statusReason: "historical_backfill",
      workflowSlug: "sales-cold-email-outreach-tectonic",
      featureSlug: "sales-cold-email-outreach",
    });
    expect(v.servedAt).toEqual(new Date("2026-04-24T00:03:45.383Z"));
    expect(v.statusDetails).toContain("ic1");
  });

  it("carries the (leadId, campaignId) conflict anchor for idempotent re-runs", () => {
    const { pairs } = dedupeSourceRows([row({ campaignId: "cAnchor" })]);
    const v = buildMembershipValue(pairs[0], "lead-x");
    expect(v.leadId).toBe("lead-x");
    expect(v.campaignId).toBe("cAnchor");
  });
});
