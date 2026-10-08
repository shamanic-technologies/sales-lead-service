import { describe, it, expect } from "vitest";
import { toLeadSources } from "../../src/lib/lead-sources.js";

const ORIGINS = new Map([
  ["apollo_search", { slug: "sourcing-apollo-cold-filters", name: "Apollo Cold Filters" }],
  ["linkedin_engagement", { slug: "sourcing-linkedin-engagement-signals", name: "LinkedIn Engagement Signals" }],
]);

describe("toLeadSources", () => {
  it("puts the serving source first, then by customer name", () => {
    const out = toLeadSources(
      [
        { audienceId: "b", offerId: null, list: "linkedin_engagement", provenance: "found_taken" },
        { audienceId: "c", offerId: null, list: "apollo_search", provenance: "found_taken" },
        { audienceId: "a", offerId: "o", list: "linkedin_engagement", provenance: "served" },
      ],
      ORIGINS,
    );
    expect(out.map((s) => [s.audienceId, s.servedLead, s.origin?.name])).toEqual([
      ["a", true, "LinkedIn Engagement Signals"],
      ["c", false, "Apollo Cold Filters"],
      ["b", false, "LinkedIn Engagement Signals"],
    ]);
  });

  it("never invents a name: no list kind, or one the catalogue does not name, is origin null", () => {
    const out = toLeadSources(
      [
        { audienceId: "x", offerId: null, list: null, provenance: "served" },
        { audienceId: "y", offerId: null, list: "some_new_kind", provenance: "found_taken" },
      ],
      ORIGINS,
    );
    expect(out.map((s) => s.origin)).toEqual([null, null]);
    expect(out.map((s) => s.list)).toEqual([null, "some_new_kind"]);
  });

  it("is empty when nothing found the person", () => {
    expect(toLeadSources([], ORIGINS)).toEqual([]);
  });
});
