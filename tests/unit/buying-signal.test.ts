import { describe, expect, it } from "vitest";
import { readBuyingSignal } from "../../src/lib/buying-signal.js";
import { ServedBuyingSignalSchema } from "../../src/schemas.js";

const signal = {
  type: "job_change",
  occurredOn: "2026-09-10",
  fact: "Dana Ruiz started as Head of Operations at Acme on September 10, 2026",
  source: "apollo:employment_history",
  sourceUrl: null,
};

const engagementSignal = {
  type: "linkedin_engagement",
  occurredOn: "2026-09-28",
  fact: "Dana Ruiz commented on a LinkedIn post by Rival Co on September 28, 2026",
  source: "linkedin:company/rival-co",
  sourceUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1",
  engagement: {
    competitorPage: "https://www.linkedin.com/company/rival-co",
    postUrl: "https://www.linkedin.com/feed/update/urn:li:activity:1",
    postPublishedOn: "2026-09-27",
    kind: "comment",
    reactionType: null,
    commentText: "Great insight",
    commentedAt: "2026-09-28",
  },
};

describe("readBuyingSignal: carried, never derived", () => {
  it("absent and null are both no signal", () => {
    expect(readBuyingSignal(undefined)).toBeNull();
    expect(readBuyingSignal(null)).toBeNull();
  });

  it("carries a complete signal verbatim", () => {
    expect(readBuyingSignal(signal)).toEqual(signal);
  });

  it("an existing kind reads byte-identical: no engagement key is added", () => {
    expect(JSON.stringify(readBuyingSignal(signal))).toBe(JSON.stringify(signal));
    expect(readBuyingSignal(signal)).not.toHaveProperty("engagement");
  });

  it("carries a linkedin_engagement signal with its engagement evidence verbatim", () => {
    expect(readBuyingSignal(engagementSignal)).toEqual(engagementSignal);
    const reaction = {
      ...engagementSignal,
      engagement: { ...engagementSignal.engagement, kind: "reaction", reactionType: "LIKE", commentText: null, commentedAt: null, postUrl: null },
    };
    expect(readBuyingSignal(reaction)).toEqual(reaction);
  });

  it("an omitted sourceUrl reads as null, not as a guessed link", () => {
    const { sourceUrl: _omit, ...rest } = signal;
    expect(readBuyingSignal(rest)?.sourceUrl).toBeNull();
  });

  it.each([
    ["an unknown type", { ...signal, type: "press_mention" }],
    ["no date", { ...signal, occurredOn: undefined }],
    ["an empty fact", { ...signal, fact: "  " }],
    ["no source", { ...signal, source: undefined }],
    ["a non-object", "hiring"],
    ["an array", [signal]],
    ["an engagement of unknown kind", { ...engagementSignal, engagement: { ...engagementSignal.engagement, kind: "share" } }],
    ["an engagement without its page", { ...engagementSignal, engagement: { ...engagementSignal.engagement, competitorPage: undefined } }],
    ["a non-object engagement", { ...engagementSignal, engagement: "comment" }],
  ])("refuses %s rather than trimming it to what parses", (_label, raw) => {
    expect(() => readBuyingSignal(raw)).toThrow(/malformed buyingSignal/);
  });
});

describe("ServedBuyingSignal contract", () => {
  it("is exactly the signal readBuyingSignal returns", () => {
    expect(ServedBuyingSignalSchema.parse(readBuyingSignal(signal))).toEqual(signal);
  });

  it("names every signal type the producer serves, and only those", () => {
    for (const type of ["hiring", "job_change", "funding", "linkedin_engagement"]) {
      expect(ServedBuyingSignalSchema.safeParse({ ...signal, type }).success).toBe(true);
    }
    expect(ServedBuyingSignalSchema.safeParse({ ...signal, type: "press_mention" }).success).toBe(false);
  });

  it("serves the engagement evidence exactly as read", () => {
    expect(ServedBuyingSignalSchema.parse(readBuyingSignal(engagementSignal))).toEqual(engagementSignal);
  });
});
