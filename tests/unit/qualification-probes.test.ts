import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROBES,
  bindCall,
  catalogEntryToCall,
  linkedinCompanySlug,
  MissingCompanyFactError,
  probeKey,
  probeSpecProblems,
  type CompanySubject,
} from "../../src/lib/qualification-probes.js";

const subject: CompanySubject = {
  domain: "acme.com",
  websiteUrl: "https://acme.com",
  companyName: "Acme",
  companyLinkedinUrl: "https://www.linkedin.com/company/acme-inc/",
};

describe("qualification probe catalogue", () => {
  it("every built-in probe is well formed", () => {
    for (const [key, { spec }] of Object.entries(BUILTIN_PROBES)) {
      expect(probeSpecProblems(spec), key).toEqual([]);
    }
  });

  it("binds placeholders from the company facts", () => {
    const spec = BUILTIN_PROBES.homepage_text.spec;
    if (spec.kind !== "treg") throw new Error("expected treg");
    expect(bindCall(spec.calls[0], subject)).toEqual({ url: "https://acme.com", format: "md" });
  });

  it("derives the LinkedIn slug", () => {
    expect(linkedinCompanySlug(subject.companyLinkedinUrl)).toBe("acme-inc");
    expect(linkedinCompanySlug("https://acme.com")).toBeNull();
    const spec = BUILTIN_PROBES.linkedin_company_posts.spec;
    if (spec.kind !== "treg") throw new Error("expected treg");
    expect(bindCall(spec.calls[2], subject)).toEqual({ companyUniversalName: "acme-inc" });
  });

  it("refuses to invent a missing fact", () => {
    const spec = BUILTIN_PROBES.linkedin_company_posts.spec;
    if (spec.kind !== "treg") throw new Error("expected treg");
    expect(() => bindCall(spec.calls[0], { ...subject, companyLinkedinUrl: null })).toThrow(MissingCompanyFactError);
  });

  it("flags an unknown placeholder", () => {
    expect(
      probeSpecProblems({
        kind: "treg",
        label: "x",
        reading: "text",
        calls: [{ endpointId: "a.b", method: "GET", params: { q: "{ceoEmail}" }, maxMicro: 1000 }],
      }),
    ).toEqual(["a.b: unknown placeholder {ceoEmail}"]);
  });

  it("the probe key ignores parameter order", () => {
    const a = probeKey({ kind: "treg", label: "a", reading: "text", calls: [{ endpointId: "e", method: "GET", params: { x: 1, y: "{domain}" }, maxMicro: 1 }] });
    const b = probeKey({ kind: "treg", label: "b", reading: "text", calls: [{ endpointId: "e", method: "GET", params: { y: "{domain}", x: 1 }, maxMicro: 1 }] });
    expect(a).toBe(b);
  });
});

describe("treg catalogue entry -> probe call", () => {
  const base = {
    id: "branddev.brand.screenshot",
    method: "GET",
    platform_eligible: true,
    async: null,
    cost: { type: "per_success", usd: 0.002534, unit: "call" },
    input: { queryParams: { domain: { required: true }, fullScreenshot: { required: false } } },
  };

  it("binds a domain endpoint and holds twice its price", () => {
    const r = catalogEntryToCall(base);
    expect(r).toEqual({
      ok: true,
      vendorUsd: 0.002534,
      call: { endpointId: "branddev.brand.screenshot", method: "GET", params: { domain: "{domain}" }, maxMicro: 5068 },
    });
  });

  it("a url is the LinkedIn page on a LinkedIn endpoint, the website elsewhere", () => {
    const li = catalogEntryToCall({ ...base, id: "tikhub.x.linkedin-web-v2-get-company-posts", input: { queryParams: { url: { required: true } } } });
    expect(li.ok && li.call.params).toEqual({ url: "{companyLinkedinUrl}" });
    const web = catalogEntryToCall({ ...base, id: "crawl4ai.web.scrape", method: "POST", input: { body: { url: { required: true } } } });
    expect(web.ok && web.call.params).toEqual({ url: "{websiteUrl}" });
  });

  it("refuses what it cannot bound or bind", () => {
    expect(catalogEntryToCall({ ...base, platform_eligible: false })).toEqual({ ok: false, reason: "not_on_platform_key" });
    expect(catalogEntryToCall({ ...base, async: { poll: "x" } })).toEqual({ ok: false, reason: "async_task" });
    expect(catalogEntryToCall({ ...base, cost: { type: "per_result", usd: 0.01 } })).toEqual({ ok: false, reason: "unbounded_price" });
    expect(catalogEntryToCall({ ...base, cost: { type: "per_call", usd: null } })).toEqual({ ok: false, reason: "no_price" });
    expect(catalogEntryToCall({ ...base, input: { queryParams: { domain: { required: true }, apiVersion: { required: true } } } })).toEqual({
      ok: false,
      reason: "unbindable_input",
    });
    expect(catalogEntryToCall({ ...base, input: { queryParams: { q: { required: false } } } })).toEqual({ ok: false, reason: "takes_no_company_input" });
  });
});
