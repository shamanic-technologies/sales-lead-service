import { beforeEach, describe, expect, it, vi } from "vitest";

let rawRows: Array<Record<string, unknown>> = [];

const sqlMock = vi.fn((strings: TemplateStringsArray) => {
  if (String(strings[0]).includes("SELECT")) {
    return Promise.resolve(rawRows);
  }
  return { fragment: strings.join("") };
});

vi.mock("../../src/db/index.js", () => ({
  sql: sqlMock,
}));

function rawRow(servedAt: unknown) {
  return {
    id: "lc-1",
    lead_id: "lead-1",
    campaign_id: "campaign-1",
    org_id: "org-1",
    user_id: null,
    brand_ids: ["brand-1"],
    status: "served",
    status_reason: null,
    status_details: null,
    parent_run_id: null,
    run_id: null,
    served_at: servedAt,
    workflow_slug: null,
    feature_slug: null,
    l_id: "lead-1",
    apollo_person_id: "apollo-1",
    first_name: "Jane",
    last_name: "Doe",
    name: "Jane Doe",
    headline: "CEO",
    linkedin_url: null,
    photo_url: null,
    org_id_inner: "org-inner-1",
    org_name: "Acme",
    logo_url: null,
    primary_domain: "acme.com",
    website_url: "https://acme.com",
    email_value: "jane@example.com",
    email_status: "valid",
  };
}

describe("fetchBasicLeadRows", () => {
  beforeEach(() => {
    rawRows = [];
    sqlMock.mockClear();
  });

  it("normalizes postgres timestamp strings for servedAt", async () => {
    rawRows = [rawRow("2026-06-17 01:44:59.123456+00")];
    const { fetchBasicLeadRows } = await import("../../src/lib/basic-leads.js");

    const rows = await fetchBasicLeadRows({ orgId: "org-1", brandId: "brand-1" });

    expect(rows[0].servedAt).toBe("2026-06-17T01:44:59.123Z");
  });

  it("keeps Date timestamps compatible with the full path", async () => {
    rawRows = [rawRow(new Date("2026-06-17T01:44:59.000Z"))];
    const { fetchBasicLeadRows } = await import("../../src/lib/basic-leads.js");

    const rows = await fetchBasicLeadRows({ orgId: "org-1" });

    expect(rows[0].servedAt).toBe("2026-06-17T01:44:59.000Z");
  });
});
