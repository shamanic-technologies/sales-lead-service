import { describe, expect, it } from "vitest";
import { contentOfAnswer, criterionKey, findImageUrl, normalizeDomain, subjectFromOrganization } from "../../src/lib/qualification.js";
import { BUILTIN_PROBES } from "../../src/lib/qualification-probes.js";
import type { OrganizationView } from "../../src/lib/lead-shape.js";
import { keepsDraft, readDraftChecks, recommendRoles, ROLE_REASONS, SuggestionDraftUnreadableError, type KeptDraft } from "../../src/lib/qualification-run.js";

describe("qualification helpers", () => {
  it("normalizes a domain from any spelling, refuses garbage", () => {
    expect(normalizeDomain("https://www.Acme.com/pricing?x=1")).toBe("acme.com");
    expect(normalizeDomain("acme.co.uk")).toBe("acme.co.uk");
    expect(normalizeDomain("http://acme.com:8080")).toBe("acme.com");
    expect(normalizeDomain("not a domain")).toBeNull();
    expect(normalizeDomain(null)).toBeNull();
  });

  it("the company subject needs a domain, from primaryDomain or the website", () => {
    const org = { name: "Acme", primaryDomain: null, websiteUrl: "http://www.acme.com", linkedinUrl: null } as unknown as OrganizationView;
    expect(subjectFromOrganization(org)).toEqual({ domain: "acme.com", websiteUrl: "https://acme.com", companyName: "Acme", companyLinkedinUrl: null });
    expect(subjectFromOrganization({ ...org, websiteUrl: null } as OrganizationView)).toBeNull();
    expect(subjectFromOrganization(null)).toBeNull();
  });

  it("finds the screenshot link in a provider answer", () => {
    expect(findImageUrl({ status: "ok", data: { screenshot: "https://cdn.brand.dev/x/abc.png" } })).toBe("https://cdn.brand.dev/x/abc.png");
    expect(findImageUrl({ screenshotUrl: "https://cdn.example.com/render?id=9" })).toBe("https://cdn.example.com/render?id=9");
    expect(findImageUrl({ text: "no image here" })).toBeNull();
  });

  it("reads the routed output, and truncates a huge answer", () => {
    expect(contentOfAnswer({ output: { jobs: [1] }, _treg: { served_by: "x" }, raw: {} })).toBe('{"jobs":[1]}');
    expect(contentOfAnswer("x".repeat(200_000)).length).toBe(100_000);
    expect(contentOfAnswer({ bytes: 1, ladder: [], markdown: "# Acme\nSubscribe" })).toBe("# Acme\nSubscribe");
  });

  it("the same question through the same probe is one judgment identity, whatever the case and spacing", () => {
    const spec = BUILTIN_PROBES.homepage_text.spec;
    expect(criterionKey("Is there a  newsletter?", spec)).toBe(criterionKey("is there a newsletter?", spec));
    expect(criterionKey("Is there a newsletter?", spec)).not.toBe(criterionKey("Is there a newsletter?", BUILTIN_PROBES.company_data.spec));
  });
});

describe("suggestions keep need signals, drop firmographics unless universal for the offer", () => {
  const base = { question: "q", why: "w", source: "homepage_text" };
  it("keeps a need signal", () => {
    expect(keepsDraft({ ...base, kind: "need" })).toEqual({ keep: true });
  });
  it("drops a firmographic unless stated universal with a reason", () => {
    expect(keepsDraft({ ...base, kind: "firmographic" })).toEqual({ keep: false, reason: "firmographic_not_universal" });
    expect(keepsDraft({ ...base, kind: "firmographic", universal: true })).toEqual({ keep: false, reason: "firmographic_not_universal" });
    expect(keepsDraft({ ...base, kind: "firmographic", universal: true, universalWhy: "The offer only works for companies selling online." })).toEqual({ keep: true });
  });
  it("drops an unclassified check", () => {
    expect(keepsDraft({ ...base })).toEqual({ keep: false, reason: "unclassified_kind:undefined" });
  });
});

describe("the suggestion draft is read in both shapes the model answers", () => {
  const check = { question: "q", why: "w", kind: "need", source: "homepage_text" };
  it("reads {checks: [...]} and the bare list (prod 2026-10-07, chiropractic offer)", () => {
    expect(readDraftChecks({ checks: [check] }, "")).toEqual([check]);
    expect(readDraftChecks([check], "")).toEqual([check]);
  });
  it("anything else throws with the raw answer", () => {
    expect(() => readDraftChecks({ suggestions: [] }, '{"suggestions":[]}')).toThrow(SuggestionDraftUnreadableError);
    expect(() => readDraftChecks(null, "not json")).toThrow(/not json/);
  });
});

describe("the recommended role: must have sparingly (SIGNALS-TITLE-AND-ROLE-1016)", () => {
  const draft = (over: Partial<KeptDraft>): KeptDraft => ({
    title: "t",
    question: "q?",
    why: "w",
    spec: BUILTIN_PROBES.company_data.spec,
    role: "mention",
    roleWhy: "",
    ...over,
  });

  it("keeps at most ONE must have, the first asked for on data we already hold", () => {
    const roles = recommendRoles([
      draft({ role: "mention", roleWhy: "Proof for the email." }),
      draft({ role: "must_pass", roleWhy: "Only online sellers can use it." }),
      draft({ role: "must_pass", roleWhy: "Second one." }),
    ]);
    expect(roles).toEqual([
      { mode: "mention", reason: "Proof for the email." },
      { mode: "must_pass", reason: "Only online sellers can use it." },
      { mode: "mention", reason: ROLE_REASONS.oneMustHave },
    ]);
  });

  it("a must have needing a paid lookup is recommended as a mention, and leaves the slot free", () => {
    const roles = recommendRoles([
      draft({ role: "must_pass", spec: BUILTIN_PROBES.homepage_text.spec, roleWhy: "x" }),
      draft({ role: "must_pass", roleWhy: "" }),
    ]);
    expect(roles).toEqual([
      { mode: "mention", reason: ROLE_REASONS.needsLookup },
      { mode: "must_pass", reason: ROLE_REASONS.mustPass },
    ]);
  });

  it("no must have asked = every check a mention", () => {
    expect(recommendRoles([draft({}), draft({ spec: BUILTIN_PROBES.job_postings.spec })]).map((r) => r.mode)).toEqual(["mention", "mention"]);
    expect(recommendRoles([draft({})])[0].reason).toBe(ROLE_REASONS.mention);
  });
});
