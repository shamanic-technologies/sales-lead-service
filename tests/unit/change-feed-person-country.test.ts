import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ sql: vi.fn(), db: {} }));

const { freshFeedRows } = await import("../../src/lib/lead-change-feed.js");
const { toCompactLead } = await import("../../src/lib/compact-lead.js");
const { modelDeliveryFor } = await import("../../src/lib/lead-read-model.js");

// The change feed stores each row as the serialized `view=compact` element. A consumer holding a copy
// reads the PERSON's own country under `lead.country`, exactly as the compact row states it: the
// person's value, null when unknown, never the company's country in its place.

const scope = {
  orgId: "org-1",
  brandId: "brand-1",
  campaignIds: ["camp-1"],
  statuses: ["served"],
  queryOrgId: null,
  userId: null,
  workflowSlug: null,
  deliveryQueried: true,
};

function row(id: string, personCountry: string | null) {
  return {
    id,
    leadId: `lead-${id}`,
    campaignId: "camp-1",
    orgId: "org-1",
    userId: null,
    brandIds: ["brand-1"],
    status: "served",
    servedAt: "2026-09-01T00:00:00.000Z",
    lastServedAt: "2026-09-01T00:00:00.000Z",
    audienceId: null,
    workflowSlug: "wf",
    channelSentAt: null,
    email: { value: `${id}@x.com`, status: "verified" },
    lead: {
      firstName: "Ann",
      lastName: "Lee",
      photoUrl: null,
      currentTitle: "CEO",
      seniority: "c_suite",
      country: personCountry,
      organization: {
        id: "org-a",
        name: "Acme",
        logoUrl: null,
        primaryDomain: "acme.fr",
        websiteUrl: null,
        industry: null,
        estimatedNumEmployees: null,
        city: "Lyon",
        country: "France",
      },
    },
  } as any;
}

describe("change feed row: the person's country", () => {
  it("states lead.country exactly as the compact row does, null when unknown", () => {
    const rows = [row("a", "United States"), row("b", null)];
    const feed = freshFeedRows(scope, rows, new Map(), new Map());
    const payloads = feed.map((f) => JSON.parse(f.payload));

    expect(payloads[0].lead.country).toBe("United States");
    expect(payloads[0].lead.organization.country).toBe("France");
    expect(payloads[1].lead.country).toBeNull();
    expect(payloads[1].lead.organization.country).toBe("France");

    rows.forEach((r, i) => {
      const compact = toCompactLead(r, modelDeliveryFor(scope, r.status, undefined, null), null);
      expect(payloads[i]).toEqual(JSON.parse(JSON.stringify(compact)));
    });
  });

  it("re-versions a row whose person country changed (its hash moves)", () => {
    const [before] = freshFeedRows(scope, [row("a", null)], new Map(), new Map());
    const [after] = freshFeedRows(scope, [row("a", "Canada")], new Map(), new Map());
    expect(after.hash).not.toBe(before.hash);
  });
});
