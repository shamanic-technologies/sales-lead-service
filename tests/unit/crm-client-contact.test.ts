import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/config.js", () => ({
  CRM_SERVICE_URL: "http://crm:3016",
  CRM_SERVICE_API_KEY: "test-crm-key",
}));

const { normalizeCrmContact } = await import("../../src/lib/crm-client.js");

const base = {
  id: "c1",
  brandId: "b1",
  externalId: "ghl-1",
  primaryEmail: "dana@acme.com",
  phoneE164: null,
  fullName: "Dana Jones",
  firstName: "Dana",
  lastName: "Jones",
  unsubscribed: false,
};

describe("normalizeCrmContact", () => {
  // crm-service groups company into `company: { name, website }`; reading only the flat
  // `companyName` is what blanked every contact's company once that shipped.
  it("reads the company from the nested shape crm-service serves", () => {
    const c = normalizeCrmContact({ ...base, company: { name: "Acme", website: "https://acme.com" } });
    expect(c.companyName).toBe("Acme");
    expect(c.companyUrl).toBe("https://acme.com");
  });

  it("still reads the older flat companyName", () => {
    expect(normalizeCrmContact({ ...base, companyName: "Acme" }).companyName).toBe("Acme");
  });

  it("states an absent company and absent provenance as null, never a default", () => {
    const c = normalizeCrmContact(base);
    expect(c.companyName).toBeNull();
    expect(c.companyUrl).toBeNull();
    expect(c.record).toEqual({
      type: null,
      leadSource: null,
      tags: null,
      createdAt: null,
      updatedAt: null,
      origin: { medium: null, url: null, referrer: null },
    });
  });

  it("carries their provenance verbatim and refuses a tag list that is not a list of words", () => {
    const c = normalizeCrmContact({
      ...base,
      record: {
        type: "lead",
        leadSource: "Meta Ads",
        tags: [],
        createdAt: "2026-09-19T21:07:55.341Z",
        updatedAt: null,
        origin: { medium: "form", url: "https://x.test/p", referrer: "" },
      },
    });
    expect(c.record).toEqual({
      type: "lead",
      leadSource: "Meta Ads",
      tags: [],
      createdAt: "2026-09-19T21:07:55.341Z",
      updatedAt: null,
      origin: { medium: "form", url: "https://x.test/p", referrer: null },
    });
    expect(normalizeCrmContact({ ...base, record: { tags: [1, 2] } }).record!.tags).toBeNull();
  });
});
