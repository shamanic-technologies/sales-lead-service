import { describe, expect, it } from "vitest";
import { judgeAudienceForSource } from "../../src/lib/source-stock-belongs.js";

// LEAK-1012 part 2: a find belongs to the source holding it only if its audience is of the source's offer, its own
// list is the source's origin.
describe("judgeAudienceForSource", () => {
  const unit = { id: "unit-wa", featureSlug: "sourcing-crm-contacts", offerId: "offer-1" };
  const crm = new Set(["sourcing-crm-contacts"]);
  const crmLists = new Set(["crm_contacts"]);

  it("accepts the funnel's own audience", () => {
    expect(judgeAudienceForSource(unit, crm, { id: "aud-phone", offerId: "offer-1", originSlug: "sourcing-crm-contacts" }, crmLists)).toEqual({ belongs: true });
  });

  it("refuses an audience of another offer", () => {
    const v = judgeAudienceForSource(unit, crm, { id: "aud-x", offerId: "offer-2", originSlug: "sourcing-apollo-cold-filters" }, crmLists);
    expect(v).toEqual({ belongs: false, reason: expect.stringContaining("belongs to offer offer-2; source unit-wa finds for offer offer-1") });
  });

  it("refuses an audience whose own list is another origin (Apollo under a CRM source)", () => {
    const v = judgeAudienceForSource(unit, crm, { id: "aud-apollo", offerId: "offer-1", originSlug: "sourcing-apollo-cold-filters" }, crmLists);
    expect(v).toEqual({ belongs: false, reason: expect.stringContaining("whose own list is sourcing-apollo-cold-filters") });
    expect(judgeAudienceForSource(unit, crm, { id: "aud-none", offerId: "offer-1", originSlug: null }, crmLists)).toMatchObject({ belongs: false });
  });

  it("every audience of its origin and offer belongs: a campaign audience pick no longer decides (LEAK-1012)", () => {
    expect(judgeAudienceForSource(unit, crm, { id: "aud-email", offerId: "offer-1", originSlug: "sourcing-crm-contacts" }, crmLists)).toEqual({ belongs: true });
  });

  // AUDIENCE-SOURCES-1016: a source is not an audience; a find made through a source of the unit's origin belongs.
  describe("an audience found through a SOURCE", () => {
    const signals = { id: "unit-sig", featureSlug: "sourcing-apollo-buying-signals", offerId: "offer-1" };
    const sigOrigins = new Set(["sourcing-apollo-buying-signals"]);
    const sigLists = new Set(["apollo_buying_signal"]);
    const employed = {
      id: "aud-employed",
      offerId: "offer-1",
      originSlug: "sourcing-apollo-cold-filters",
      channels: [
        { list: "apollo_search", sourceId: null, status: null },
        { list: "apollo_buying_signal", sourceId: "src-hiring", status: "paused" },
      ],
    };

    it("belongs to the Buying Signals unit through its hiring source, even once that source is off", () => {
      expect(judgeAudienceForSource(signals, sigOrigins, employed, sigLists)).toEqual({ belongs: true });
    });

    it("still belongs to the Cold Filters unit through its own list", () => {
      const cold = { ...signals, id: "unit-cold", featureSlug: "sourcing-apollo-cold-filters" };
      expect(judgeAudienceForSource(cold, new Set(["sourcing-apollo-cold-filters"]), employed, new Set(["apollo_search"]))).toEqual({ belongs: true });
    });

    it("never belongs to a CRM unit: no source is a CRM list", () => {
      expect(judgeAudienceForSource(unit, crm, employed, crmLists)).toMatchObject({ belongs: false });
    });
  });
});
