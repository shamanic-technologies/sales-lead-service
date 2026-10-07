import { describe, expect, it } from "vitest";
import { contentOfAnswer, criterionKey, findImageUrl, normalizeDomain, subjectFromOrganization } from "../../src/lib/qualification.js";
import { BUILTIN_PROBES } from "../../src/lib/qualification-probes.js";
import type { OrganizationView } from "../../src/lib/lead-shape.js";

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
