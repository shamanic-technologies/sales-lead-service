import { describe, it, expect } from "vitest";
import { legIdentity, OUTBOUND_RENAMED_FEATURE_SLUGS, servedLegKey } from "../../src/lib/leg-identity.js";
import { entryOfLeg, legOf, LEGS, STEP_ORDER, stepsRequiredBefore, stepsOnlyThrough } from "../../src/lib/step-graph.js";
import { buildCampaignFamilies, identityKeyOf } from "../../src/lib/campaign-identity.js";
import { LEAD_STEP_OUTCOMES } from "../../src/lib/step-statements.js";

/**
 * Outbound leg-key rename, wave 1 (owner 2026-10-09): on the outbound channels only,
 * start_to_conversation == lead_found_to_conversation and start_to_website_visit ==
 * lead_found_to_website_visit. lead-service keeps serving what it serves today.
 */

const PAIRS: Array<[string, string]> = [
  ["start_to_conversation", "lead_found_to_conversation"],
  ["start_to_website_visit", "lead_found_to_website_visit"],
];

describe("legIdentity", () => {
  it("folds both spellings onto one identity on every outbound slug", () => {
    expect(OUTBOUND_RENAMED_FEATURE_SLUGS.size).toBe(10);
    for (const slug of OUTBOUND_RENAMED_FEATURE_SLUGS) {
      for (const [legacy, renamed] of PAIRS) {
        expect(legIdentity(slug, renamed)).toBe(legIdentity(slug, legacy));
      }
    }
  });

  it("is the identity on a legacy key (byte-identical for today's callers)", () => {
    for (const [legacy] of PAIRS) expect(legIdentity("sales-cold-email-outreach", legacy)).toBe(legacy);
  });

  it("never folds a non-outbound, featureless or sourcing key", () => {
    expect(legIdentity("google-ads", "lead_found_to_website_visit")).toBe("lead_found_to_website_visit");
    expect(legIdentity("google-ads", "start_to_website_visit")).toBe("start_to_website_visit");
    expect(legIdentity(null, "lead_found_to_conversation")).toBe("lead_found_to_conversation");
    expect(legIdentity("sales-cold-email-outreach", "start_to_lead_found")).toBe("start_to_lead_found");
    expect(legIdentity("sales-cold-email-outreach", null)).toBeNull();
  });
});

describe("servedLegKey (wave 2: serve the new spelling)", () => {
  it("serves the new spelling for both spellings on every outbound slug", () => {
    for (const slug of OUTBOUND_RENAMED_FEATURE_SLUGS) {
      for (const [legacy, renamed] of PAIRS) {
        expect(servedLegKey(slug, legacy)).toBe(renamed);
        expect(servedLegKey(slug, renamed)).toBe(renamed);
      }
    }
  });

  it("never renames a non-outbound, featureless, sourcing or internal key", () => {
    expect(servedLegKey("google-ads", "start_to_website_visit")).toBe("start_to_website_visit");
    expect(servedLegKey(null, "start_to_conversation")).toBe("start_to_conversation");
    expect(servedLegKey("sales-cold-email-outreach", "start_to_lead_found")).toBe("start_to_lead_found");
    expect(servedLegKey("sales-cold-email-outreach", "conversation_to_meeting_booked")).toBe(
      "conversation_to_meeting_booked",
    );
    expect(servedLegKey("sales-cold-email-outreach", null)).toBeNull();
  });

  it("a served key is the same identity as the one read", () => {
    for (const [legacy] of PAIRS) {
      expect(legIdentity("cold-call-outreach", servedLegKey("cold-call-outreach", legacy))).toBe(
        legIdentity("cold-call-outreach", legacy),
      );
    }
  });
});

describe("step graph: lead_found is a normal step", () => {
  it("knows the sourcing leg and the two renamed outbound legs", () => {
    expect(legOf("start_to_lead_found")).toMatchObject({ from: null, to: "lead_found" });
    expect(legOf("lead_found_to_conversation")).toMatchObject({ from: "lead_found", to: "conversation" });
    expect(legOf("lead_found_to_website_visit")).toMatchObject({ from: "lead_found", to: "website_visit" });
  });

  it("an outbound leg enters where its legacy spelling enters (standing reads the same)", () => {
    for (const [legacy, renamed] of PAIRS) {
      const a = entryOfLeg(legOf(legacy)!);
      const b = entryOfLeg(legOf(renamed)!);
      expect({ ...b, legKey: legacy }).toEqual(a);
      expect(b.legKey).toBe(renamed);
    }
  });

  it("a sourcing leg enters at lead_found, observed by nothing here", () => {
    const e = entryOfLeg(legOf("start_to_lead_found")!);
    expect(e).toMatchObject({ step: "lead_found", measure: null });
    expect(e.reachableSteps).toEqual(STEP_ORDER);
  });

  it("adding lead_found changes no step order and no implication between statable steps", () => {
    expect(STEP_ORDER).toEqual([
      "website_visit",
      "signup",
      "meeting_booked",
      "form_submission",
      "meeting_attended",
      "sale",
    ]);
    const before: Record<string, string[]> = {
      signup: ["website_visit"],
      meeting_booked: [],
      form_submission: [],
      sale: [],
      meeting_attended: ["meeting_booked"],
      website_visit: [],
    };
    for (const step of LEAD_STEP_OUTCOMES) {
      expect([...stepsRequiredBefore(step)].sort()).toEqual([...before[step]].sort());
    }
    expect(stepsOnlyThrough("website_visit")).toEqual(["signup"]);
  });

  it("keeps the legacy start_to_* legs for non-outbound channels (ads still enter at the visit)", () => {
    expect(LEGS.some((l) => l.legKey === "start_to_website_visit" && l.from === null)).toBe(true);
    expect(entryOfLeg(legOf("start_to_website_visit")!)).toMatchObject({ step: "website_visit", measure: "delivery_click" });
  });
});

describe("campaign identity families fold the two outbound spellings", () => {
  const base = {
    orgId: "o",
    brandId: "b",
    offerId: "offer-1",
    acquisitionChannel: "cold_email",
    featureSlug: "sales-cold-email-outreach",
  };

  it("a legacy-stored and a new-stored row of one outbound identity are one family", () => {
    for (const [legacy, renamed] of PAIRS) {
      const families = buildCampaignFamilies([
        { ...base, id: "old", legKey: legacy },
        { ...base, id: "new", legKey: renamed },
      ]);
      expect(families.familyOf("old")).toEqual(["new", "old"]);
    }
  });

  it("a legacy-only identity key is byte-identical to today's", () => {
    expect(identityKeyOf({ ...base, id: "x", legKey: "start_to_conversation" })).toBe(
      "o|b|offer-1|start_to_conversation|cold_email",
    );
  });

  it("never folds a non-outbound channel's start_to_website_visit with a lead_found key", () => {
    const ads = { ...base, acquisitionChannel: "google_ads", featureSlug: "google-ads" };
    const families = buildCampaignFamilies([
      { ...ads, id: "a1", legKey: "start_to_website_visit" },
      { ...ads, id: "a2", legKey: "lead_found_to_website_visit" },
    ]);
    expect(families.familyOf("a1")).toEqual(["a1"]);
  });
});
