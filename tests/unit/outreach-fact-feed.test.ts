import { describe, expect, it } from "vitest";
import { OutreachFactParseError, parseOutreachFact } from "../../src/lib/outreach-fact-feed.js";

const FACT = {
  seq: "42", subjectKey: "ievt:9", supersedesSeq: null, type: "email_sent", occurredAt: "2026-10-07T10:00:00.000Z",
  leadEmail: "Christina@WellConnectedChiro.com", orgId: "org-1", campaignId: "camp-1", brandIds: ["b-1"],
};

describe("an outreach fact off the wire", () => {
  it("lifts the keyed fields, email case-folded", () => {
    expect(parseOutreachFact(FACT)).toEqual({ ...FACT, leadEmail: "christina@wellconnectedchiro.com" });
  });

  it("copies a fact no org owns (orgId null, no brand)", () => {
    expect(parseOutreachFact({ ...FACT, orgId: null, brandIds: [], campaignId: null }).orgId).toBeNull();
  });

  it("keeps a fact type it does not know: naming facts is the producer's", () => {
    expect(parseOutreachFact({ ...FACT, type: "something_new" }).type).toBe("something_new");
  });

  it.each([
    ["no seq", { seq: undefined }],
    ["a non-digit seq", { seq: "x1" }],
    ["no subject", { subjectKey: "" }],
    ["campaignId missing (not null)", { campaignId: undefined }],
    ["orgId missing (not null)", { orgId: undefined }],
    ["an unreadable date", { occurredAt: "yesterday" }],
    ["brandIds not a list", { brandIds: "b-1" }],
  ])("fails the page loud on %s", (_label, over) => {
    const raw = { ...FACT, ...over } as Record<string, unknown>;
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete raw[k];
    expect(() => parseOutreachFact(raw)).toThrow(OutreachFactParseError);
  });
});
