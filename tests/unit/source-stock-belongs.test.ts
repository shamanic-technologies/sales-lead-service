import { describe, expect, it } from "vitest";
import { judgeAudienceForSource } from "../../src/lib/source-stock-belongs.js";

// LEAK-1012 part 2: a find belongs to the source holding it only if its audience is of the source's offer, its own
// list is the source's origin.
describe("judgeAudienceForSource", () => {
  const unit = { id: "unit-wa", featureSlug: "sourcing-crm-contacts", offerId: "offer-1" };
  const crm = new Set(["sourcing-crm-contacts"]);

  it("accepts the funnel's own audience", () => {
    expect(judgeAudienceForSource(unit, crm, { id: "aud-phone", offerId: "offer-1", originSlug: "sourcing-crm-contacts" })).toEqual({ belongs: true });
  });

  it("refuses an audience of another offer", () => {
    const v = judgeAudienceForSource(unit, crm, { id: "aud-x", offerId: "offer-2", originSlug: "sourcing-apollo-cold-filters" });
    expect(v).toEqual({ belongs: false, reason: expect.stringContaining("belongs to offer offer-2; source unit-wa finds for offer offer-1") });
  });

  it("refuses an audience whose own list is another origin (Apollo under a CRM source)", () => {
    const v = judgeAudienceForSource(unit, crm, { id: "aud-apollo", offerId: "offer-1", originSlug: "sourcing-apollo-cold-filters" });
    expect(v).toEqual({ belongs: false, reason: expect.stringContaining("whose own list is sourcing-apollo-cold-filters") });
    expect(judgeAudienceForSource(unit, crm, { id: "aud-none", offerId: "offer-1", originSlug: null })).toMatchObject({ belongs: false });
  });

  it("every audience of its origin and offer belongs: a campaign audience pick no longer decides (LEAK-1012)", () => {
    expect(judgeAudienceForSource(unit, crm, { id: "aud-email", offerId: "offer-1", originSlug: "sourcing-crm-contacts" })).toEqual({ belongs: true });
  });
});
