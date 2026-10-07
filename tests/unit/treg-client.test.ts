import { afterEach, describe, expect, it, vi } from "vitest";
import { InsufficientCreditError, TregMeter, isTregRefusal } from "../../src/lib/treg-client.js";

const identity = { orgId: "org-1", userId: "user-1", runId: "run-1", brandId: "brand-1" };

type Step = { match: (url: string, init: RequestInit) => boolean; respond: () => Response };

function script(steps: Step[]) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const step = steps.find((s) => s.match(url, init));
    if (!step) throw new Error(`unexpected fetch ${init.method} ${url}`);
    return step.respond();
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function keys(keySource: "org" | "platform"): Step[] {
  return [
    { match: (u) => u.includes("/keys/treg/decrypt"), respond: () => json({ key: "tok", keySource }) },
    { match: (u) => u.includes("/keys/treg-org/decrypt"), respond: () => json({ key: "team", keySource }) },
  ];
}
const runsPost: Step = { match: (u, i) => u.includes("/v1/runs/run-1/costs") && i.method === "POST", respond: () => json({ costs: [{ id: "hold-1" }] }) };
const runsCancel: Step = { match: (u, i) => u.includes("/v1/runs/run-1/costs/hold-1") && i.method === "PATCH", respond: () => json({ id: "hold-1" }) };

afterEach(() => vi.unstubAllGlobals());

describe("TregMeter", () => {
  it("provisions, authorizes (platform key), calls, posts the real charge, cancels the hold", async () => {
    const calls = script([
      ...keys("platform"),
      runsPost,
      runsCancel,
      { match: (u) => u.includes("/v1/customer_balance/authorize"), respond: () => json({ sufficient: true, balance_cents: 1000, required_cents: 1 }) },
      { match: (u) => u.startsWith("https://treg.to/call/branddev.brand.screenshot"), respond: () => json({ url: "https://cdn/x.png" }, 200, { "x-treg-cost-micro": "2534" }) },
    ]);
    const r = await new TregMeter(identity).call({ endpointId: "branddev.brand.screenshot", method: "GET", params: { domain: "acme.com" }, maxMicro: 5000 });
    expect(r).toMatchObject({ status: 200, chargedMicro: 2534 });
    const order = calls.map((c) => `${c.init.method} ${c.url.replace(/^https?:\/\/[^/]+/, "")}`).filter((s) => !s.includes("decrypt"));
    expect(order).toEqual([
      "POST /v1/runs/run-1/costs",
      "POST /v1/customer_balance/authorize",
      "GET /call/branddev.brand.screenshot?domain=acme.com",
      "POST /v1/runs/run-1/costs",
      "PATCH /v1/runs/run-1/costs/hold-1",
    ]);
    const hold = JSON.parse(String(calls.find((c) => c.url.includes("/costs") && c.init.method === "POST")!.init.body));
    expect(hold.items[0]).toMatchObject({ costName: "treg-micro-usd", quantity: 5000, status: "provisioned", costSource: "platform" });
    const treg = calls.find((c) => c.url.includes("treg.to"))!;
    expect((treg.init.headers as Record<string, string>)["X-Treg-Route-Max-Cost"]).toBe("0.005000");
    const actual = JSON.parse(String(calls.filter((c) => c.url.includes("/costs") && c.init.method === "POST")[1].init.body));
    expect(actual.items[0]).toMatchObject({ costName: "treg-micro-usd", quantity: 2534 });
    expect(actual.items[0].status).toBeUndefined();
  });

  it("an org's own key is not authorized against our credit", async () => {
    const calls = script([
      ...keys("org"),
      runsPost,
      runsCancel,
      { match: (u) => u.startsWith("https://treg.to/call/"), respond: () => json({}, 200, { "x-treg-cost-micro": "0" }) },
    ]);
    await new TregMeter(identity).call({ endpointId: "a.b", method: "POST", params: { url: "https://acme.com" }, maxMicro: 1000 });
    expect(calls.some((c) => c.url.includes("authorize"))).toBe(false);
  });

  it("insufficient credit cancels the hold and calls nothing", async () => {
    const calls = script([
      ...keys("platform"),
      runsPost,
      runsCancel,
      { match: (u) => u.includes("authorize"), respond: () => json({ sufficient: false, balance_cents: 0, required_cents: 1 }) },
    ]);
    await expect(new TregMeter(identity).call({ endpointId: "a.b", method: "GET", params: {}, maxMicro: 1000 })).rejects.toBeInstanceOf(InsufficientCreditError);
    expect(calls.some((c) => c.url.includes("treg.to"))).toBe(false);
    expect(calls.some((c) => c.init.method === "PATCH")).toBe(true);
  });

  it("a 2xx without its charge fails loud and leaves the hold open", async () => {
    const calls = script([
      ...keys("platform"),
      runsPost,
      runsCancel,
      { match: (u) => u.includes("authorize"), respond: () => json({ sufficient: true }) },
      { match: (u) => u.includes("treg.to"), respond: () => json({ ok: 1 }) },
    ]);
    await expect(new TregMeter(identity).call({ endpointId: "a.b", method: "GET", params: {}, maxMicro: 1000 })).rejects.toThrow(/X-Treg-Cost-Micro/);
    expect(calls.some((c) => c.init.method === "PATCH")).toBe(false);
  });

  it("a free failure declares nothing and closes the hold", async () => {
    const calls = script([
      ...keys("platform"),
      runsPost,
      runsCancel,
      { match: (u) => u.includes("authorize"), respond: () => json({ sufficient: true }) },
      { match: (u) => u.includes("treg.to"), respond: () => json({ error: "not_found" }, 404) },
    ]);
    const r = await new TregMeter(identity).call({ endpointId: "a.b", method: "GET", params: {}, maxMicro: 1000 });
    expect(r.chargedMicro).toBe(0);
    expect(calls.filter((c) => c.url.includes("/costs") && c.init.method === "POST")).toHaveLength(1);
  });
});

describe("isTregRefusal", () => {
  it("tells treg's own refusal from the provider's answer", () => {
    expect(isTregRefusal(402, { error: "route_max_cost" })).toBe(true);
    expect(isTregRefusal(404, { detail: "no tool 'x' in this org" })).toBe(true);
    expect(isTregRefusal(404, { error: "not_found", message: "Company not found" })).toBe(false);
  });
});
