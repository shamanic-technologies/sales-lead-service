import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));
const {
  findProfileByEmail, payingClientsOf, servedProviderOf, TransientLookupError, CAREER_ENRICH_MAX_MICRO, CAREER_LOOKUP_MAX_MICRO,
} = await import("../../src/lib/client-past-employers-read.js");

type Req = { endpointId: string; maxMicro: number; routeExclude?: readonly string[] };
const answer = (status: number, body: unknown, chargedMicro = 0) => ({ status, body, chargedMicro, contentType: "application/json" });
const miss = { output: { full_name: null, linkedin_url: null }, _treg: { served_by: null, outcome: "miss", tried: [] } };
const hit = (provider: string, output: Record<string, unknown>) => ({
  output,
  _treg: { served_by: `${provider}.people.enrich`, outcome: "hit", tried: [{ endpoint_id: `${provider}.people.enrich`, provider, outcome: "hit" }] },
});

function fakeCall(answers: Array<ReturnType<typeof answer>>) {
  const reqs: Req[] = [];
  const call = vi.fn(async (req: Req) => {
    reqs.push(req);
    const next = answers.shift();
    if (!next) throw new Error("unexpected call");
    return next;
  });
  return { call: call as never, reqs };
}

describe("findProfileByEmail", () => {
  it.each([500, 402, 429, 400, 401, 403, 404, 202])("a %i is no answer: throws, so nothing is recorded", async (status) => {
    const { call } = fakeCall([answer(status, { detail: "x" })]);
    await expect(findProfileByEmail("a@b.co", call)).rejects.toBeInstanceOf(TransientLookupError);
  });

  it("a meter failure (timeout, key-service down) propagates", async () => {
    const call = (async () => {
      throw new Error("timeout");
    }) as never;
    await expect(findProfileByEmail("a@b.co", call)).rejects.toThrow("timeout");
  });

  it("a real miss is a final « no profile », asked once, Apollo excluded, wide ceiling", async () => {
    const { call, reqs } = fakeCall([answer(200, miss)]);
    expect(await findProfileByEmail("a@b.co", call)).toEqual({ linkedinUrl: null, employer: null, charged: 0 });
    expect(reqs).toHaveLength(1);
    expect(reqs[0].routeExclude).toEqual(["apollo"]);
    expect(reqs[0].maxMicro).toBe(CAREER_ENRICH_MAX_MICRO);
  });

  it("a hit without a profile is asked again without its provider; the employer it named is kept", async () => {
    const { call, reqs } = fakeCall([
      answer(200, hit("leadocean", { full_name: "Ann Lee", company_name: "Beyond", company_domain: "beyond.tech", title: "CEO", linkedin_url: null }), 5_000),
      answer(200, hit("tomba", { full_name: "Ann Lee", linkedin_url: "https://www.linkedin.com/in/annlee" }), 8_900),
    ]);
    const out = await findProfileByEmail("a@b.co", call);
    expect(out.linkedinUrl).toBe("https://www.linkedin.com/in/annlee");
    expect(out.employer).toEqual({ name: "Beyond", domain: "beyond.tech", title: "CEO" });
    expect(out.charged).toBe(13_900);
    expect(reqs.map((r) => r.routeExclude)).toEqual([["apollo"], ["apollo", "leadocean"]]);
    expect(reqs[1].maxMicro).toBe(Math.min(CAREER_ENRICH_MAX_MICRO, CAREER_LOOKUP_MAX_MICRO - 5_000));
  });

  it("stops after its rounds", async () => {
    const { call, reqs } = fakeCall([
      answer(200, hit("p1", { full_name: "A" })),
      answer(200, hit("p2", { full_name: "A" })),
      answer(200, hit("p3", { full_name: "A" })),
    ]);
    expect((await findProfileByEmail("a@b.co", call)).linkedinUrl).toBeNull();
    expect(reqs).toHaveLength(3);
  });
});

describe("servedProviderOf", () => {
  it("reads the hit's provider, null on a miss", () => {
    expect(servedProviderOf(hit("companyenrich", {}))).toBe("companyenrich");
    expect(servedProviderOf(miss)).toBeNull();
    expect(servedProviderOf(null)).toBeNull();
  });
});

describe("payingClientsOf", () => {
  const row = (over: Record<string, unknown>) => ({
    lead_id: "l", human_id: null, name: null, emails: [], human_emails: [], linkedin_url: null, not_a_person: false, paid_at: null, ...over,
  }) as never;

  it("one client per human, held by the lead that paid first; lookup address falls back on the human's other leads", () => {
    const out = payingClientsOf([
      row({ lead_id: "b", human_id: "h", emails: [], human_emails: ["x@co.io"], paid_at: "2026-02-01T00:00:00.000Z", name: "Ann" }),
      row({ lead_id: "c", human_id: "h", emails: ["x@co.io"], paid_at: "2026-05-01T00:00:00.000Z" }),
      row({ lead_id: "a", emails: ["solo@co.io"], paid_at: null }),
    ]);
    expect(out).toEqual([
      { leadId: "a", name: null, email: "solo@co.io", linkedinUrl: null, paidAt: null },
      { leadId: "b", name: "Ann", email: "x@co.io", linkedinUrl: null, paidAt: "2026-02-01T00:00:00.000Z" },
    ]);
  });

  it("a person any of whose addresses is staff is never a client; not-a-person is out", () => {
    expect(payingClientsOf([
      row({ lead_id: "a", human_id: "h", emails: ["me@essec.edu"], human_emails: ["kevin.lourd@gmail.com"] }),
      row({ lead_id: "b", emails: ["p@co.io"], not_a_person: true }),
    ])).toEqual([]);
  });
});
