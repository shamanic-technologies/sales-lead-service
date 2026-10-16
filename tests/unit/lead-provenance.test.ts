import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { toPersonProvenance, sourceTag } from "../../src/lib/lead-provenance.js";

const ORIGINS = new Map([
  ["apollo_search", { slug: "sourcing-apollo-cold-filters", name: "Apollo Cold Filters" }],
  ["linkedin_engagement", { slug: "sourcing-linkedin-engagement-signals", name: "LinkedIn Engagement Signals" }],
]);

describe("toPersonProvenance (LEAD-SOURCE-AT-SEND-1016)", () => {
  it("carries EVERY source tag of a person found by several sources, plus lead-service filings", () => {
    const out = toPersonProvenance(
      "marie@acme.com",
      [
        { audienceId: "a", offerId: "o", list: "apollo_search", provenance: "served", joinedAt: "2026-10-01T00:00:00.000Z" },
        { audienceId: "b", offerId: "o", list: "linkedin_engagement", provenance: "found_taken", joinedAt: null },
        { audienceId: "c", offerId: "o", list: "apollo_search", provenance: "found_taken", joinedAt: null },
      ],
      [{ kind: "stated_by_org", firstAt: "2026-10-02T00:00:00.000Z" }, { kind: "crm_signup", firstAt: null }],
      ORIGINS,
    );
    expect(out.tags).toEqual([
      "crm_signup",
      "sourcing-apollo-cold-filters",
      "sourcing-linkedin-engagement-signals",
      "stated_by_org",
    ]);
    expect(out.sources.map((s) => [s.audienceId, s.servedLead, s.foundAt])).toEqual([
      ["a", true, "2026-10-01T00:00:00.000Z"],
      ["c", false, null],
      ["b", false, null],
    ]);
    expect(out.filings.map((f) => f.kind)).toEqual(["crm_signup", "stated_by_org"]);
  });

  it("never invents a name: an unnamed list kind or no list is tagged as such", () => {
    expect(sourceTag({ origin: null, list: "some_new_kind" })).toBe("list:some_new_kind");
    expect(sourceTag({ origin: null, list: null })).toBe("list:none");
  });

  it("a person nobody recorded a source for answers empty tags, not a default", () => {
    expect(toPersonProvenance("x@y.com", [], [], ORIGINS)).toEqual({ email: "x@y.com", tags: [], sources: [], filings: [] });
  });
});

describe("POST /internal/brands/:brandId/lead-provenance/by-email", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  async function appWith(read: (...args: unknown[]) => Promise<unknown>) {
    vi.doMock("../../src/lib/lead-provenance.js", () => ({ readLeadProvenanceByEmail: read, PROVENANCE_MAX_EMAILS: 1000 }));
    const routes = (await import("../../src/routes/lead-provenance.js")).default;
    const app = express();
    app.use(express.json());
    app.use(routes);
    return app;
  }

  const post = (app: express.Express, body: unknown) =>
    request(app)
      .post("/internal/brands/b1/lead-provenance/by-email")
      .set("x-api-key", "test-api-key")
      .set("x-org-id", "o1")
      .send(body as object);

  it("answers every person with the org and brand it was asked for", async () => {
    const read = vi.fn(async () => [{ email: "a@b.com", tags: ["t"], sources: [], filings: [] }]);
    const res = await post(await appWith(read), { emails: ["A@b.com"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ brandId: "b1", people: [{ email: "a@b.com", tags: ["t"], sources: [], filings: [] }], count: 1 });
    expect(read).toHaveBeenCalledWith("o1", "b1", ["A@b.com"]);
  });

  it("refuses an empty or oversized body (400)", async () => {
    const app = await appWith(vi.fn());
    expect((await post(app, { emails: [] })).status).toBe(400);
    expect((await post(app, {})).status).toBe(400);
    expect((await post(app, { emails: Array.from({ length: 1001 }, (_, i) => `p${i}@x.com`) })).status).toBe(400);
  });

  it("a source that cannot be read is a 502, never an empty answer", async () => {
    const { AudienceServiceError } = await import("../../src/lib/audience-client.js");
    const app = await appWith(async () => {
      throw new AudienceServiceError(503, "down");
    });
    const res = await post(app, { emails: ["a@b.com"] });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("provenance_source_unavailable");
  });

  it("any other failure is a 500 (no error middleware)", async () => {
    const app = await appWith(async () => {
      throw new Error("db down");
    });
    expect((await post(app, { emails: ["a@b.com"] })).status).toBe(500);
  });
});
