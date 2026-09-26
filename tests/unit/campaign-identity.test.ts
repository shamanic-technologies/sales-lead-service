import { describe, it, expect } from "vitest";
import { buildCampaignFamilies, identityKeyOf } from "../../src/lib/campaign-identity.js";

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "75d7e3e8-6926-4f85-a557-976895400666";
const OTHER_BRAND = "20000000-0000-0000-0000-000000000002";

function row(id: string, over: Partial<Parameters<typeof identityKeyOf>[0]> = {}) {
  return {
    id,
    orgId: ORG,
    brandId: BRAND,
    brandIds: [BRAND],
    offerId: "offer-1",
    legKey: "start_to_conversation",
    acquisitionChannel: "cold_email",
    status: "stopped",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("campaign identity families", () => {
  it("pools every stored row of ONE identity — the live campaign and the ancestors workflow switches stopped", () => {
    const families = buildCampaignFamilies([
      row("c1"),
      row("c2"),
      row("c3", { status: "ongoing" }),
    ]);

    expect(families.familyOf("c1")).toEqual(["c1", "c2", "c3"]);
    expect(families.familyOf("c3")).toEqual(["c1", "c2", "c3"]);
  });

  it("keeps a brand's SEVERAL identities apart — never widens a campaign scope to the whole brand", () => {
    const families = buildCampaignFamilies([
      row("cold-1"),
      row("cold-2"),
      row("crm-1", { acquisitionChannel: "crm_email" }),
      row("other-leg-1", { legKey: "start_to_website_visit" }),
      row("other-offer-1", { offerId: "offer-2" }),
    ]);

    expect(families.familyOf("cold-1")).toEqual(["cold-1", "cold-2"]);
    expect(families.familyOf("crm-1")).toEqual(["crm-1"]);
    expect(families.familyOf("other-leg-1")).toEqual(["other-leg-1"]);
    expect(families.familyOf("other-offer-1")).toEqual(["other-offer-1"]);
  });

  it("a brand with exactly one campaign row is unchanged — its family is itself", () => {
    const families = buildCampaignFamilies([row("solo")]);
    expect(families.familyOf("solo")).toEqual(["solo"]);
  });

  it("groups the offer- and leg-less rows of a channel together, exactly as campaign-service's own index does", () => {
    const families = buildCampaignFamilies([
      row("n1", { offerId: null, legKey: null }),
      row("n2", { offerId: null, legKey: null }),
      row("stated"),
    ]);

    expect(families.familyOf("n1")).toEqual(["n1", "n2"]);
    expect(families.familyOf("stated")).toEqual(["stated"]);
  });

  it("never pools a row that states no brand or no acquisition channel — it is its own family of one", () => {
    const families = buildCampaignFamilies([
      row("no-channel", { acquisitionChannel: null }),
      row("no-channel-twin", { acquisitionChannel: null }),
      row("no-brand", { brandId: null, brandIds: null }),
    ]);

    expect(identityKeyOf(row("no-channel", { acquisitionChannel: null }))).toBeNull();
    expect(families.familyOf("no-channel")).toEqual(["no-channel"]);
    expect(families.familyOf("no-channel-twin")).toEqual(["no-channel-twin"]);
    expect(families.familyOf("no-brand")).toEqual(["no-brand"]);
  });

  it("reads the brand from the legacy array when the row predates the brand_id column", () => {
    const families = buildCampaignFamilies([
      row("legacy", { brandId: null, brandIds: [BRAND] }),
      row("current"),
      row("elsewhere", { brandId: null, brandIds: [OTHER_BRAND] }),
    ]);

    expect(families.familyOf("legacy")).toEqual(["current", "legacy"]);
    expect(families.familyOf("elsewhere")).toEqual(["elsewhere"]);
  });

  it("a campaign campaign-service does not know answers for itself alone", () => {
    const families = buildCampaignFamilies([row("c1")]);
    expect(families.familyOf("unknown-campaign")).toEqual(["unknown-campaign"]);
  });
});
