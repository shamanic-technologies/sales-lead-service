/**
 * PRICE-X1-1029-LEAD: the qualification cost estimate shown to a client is priced on THAT org's
 * price list. costs-service answers the org's price from `x-org-id` (grandfathered = x2, standard
 * = x1); lead-service never multiplies, and a refusal fails the estimate instead of guessing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));
vi.mock("../../src/lib/treg-catalog-client.js", () => ({ getCatalogEntry: async () => ({}) }));
vi.mock("../../src/lib/qualification-probes.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, catalogEntryToCall: () => ({ ok: true, vendorUsd: 0.01, call: {} }) };
});

const { estimateCostPerRow } = await import("../../src/lib/qualification.js");
const { priceCentsPerUnit, clearPriceCache } = await import("../../src/lib/price-client.js");
const { BUILTIN_PROBES } = await import("../../src/lib/qualification-probes.js");

const GRANDFATHERED_ORG = "11111111-1111-4111-8111-111111111111";
const STANDARD_ORG = "22222222-2222-4222-8222-222222222222";
/** Vendor list price per unit, cents. The standard list is x1, the grandfathered list x2. */
const VENDOR = 0.0005;

type Seen = { url: string; headers: Record<string, string> };
let seen: Seen[] = [];
let respond: (s: Seen) => Response;

function priceFor(orgId: string): Response {
  const grandfathered = orgId === GRANDFATHERED_ORG;
  return new Response(
    JSON.stringify({ pricePerUnitInUsdCents: String(grandfathered ? VENDOR * 2 : VENDOR), priceList: grandfathered ? "grandfathered" : "standard" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  clearPriceCache();
  seen = [];
  respond = (s) => priceFor(s.headers["x-org-id"]);
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const s = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
    seen.push(s);
    return respond(s);
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("price read carries the org", () => {
  it("sends x-org-id and the costs-service api key", async () => {
    await priceCentsPerUnit("google-flash-lite-3.1-tokens-input", STANDARD_ORG);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://costs:3018/v1/platform-prices/google-flash-lite-3.1-tokens-input");
    expect(seen[0].headers).toMatchObject({ "x-org-id": STANDARD_ORG, "x-api-key": "test-costs-key" });
  });

  it("caches per org: a second org on another list is never served the first org's price", async () => {
    const a = await priceCentsPerUnit("google-flash-lite-3.1-tokens-input", GRANDFATHERED_ORG);
    const b = await priceCentsPerUnit("google-flash-lite-3.1-tokens-input", STANDARD_ORG);
    const a2 = await priceCentsPerUnit("google-flash-lite-3.1-tokens-input", GRANDFATHERED_ORG);
    expect(a).toBe(VENDOR * 2);
    expect(b).toBe(VENDOR);
    expect(a2).toBe(VENDOR * 2);
    expect(seen).toHaveLength(2);
  });

  it("refuses to read a price without an org", async () => {
    await expect(priceCentsPerUnit("google-flash-lite-3.1-tokens-input", "")).rejects.toThrow(/org is required/);
    expect(seen).toHaveLength(0);
  });
});

describe("estimateCostPerRow is priced on the org it is shown to", () => {
  for (const key of ["company_data", "homepage_text", "homepage_screenshot"] as const) {
    it(`${key}: grandfathered org = x2 figure, standard org = x1 figure`, async () => {
      const spec = BUILTIN_PROBES[key].spec;
      const old = await estimateCostPerRow(spec, GRANDFATHERED_ORG);
      const fresh = await estimateCostPerRow(spec, STANDARD_ORG);
      expect(fresh.perRowUsd).toBeGreaterThan(0);
      expect(old.perRowUsd).toBeCloseTo(fresh.perRowUsd * 2, 6);
      expect(old.aiUsd).toBeCloseTo(fresh.aiUsd * 2, 6);
      expect(old.probeUsd).toBeCloseTo(fresh.probeUsd * 2, 6);
      expect(new Set(seen.map((s) => s.headers["x-org-id"]))).toEqual(new Set([GRANDFATHERED_ORG, STANDARD_ORG]));
    });
  }

  it.each([401, 502])("a costs-service %i fails the estimate, never a guessed price", async (status) => {
    respond = () => new Response(JSON.stringify({ error: "refused" }), { status });
    await expect(estimateCostPerRow(BUILTIN_PROBES.company_data.spec, STANDARD_ORG)).rejects.toThrow(new RegExp(`failed: ${status}`));
  });

  it("a null price (no price for this org) fails the estimate", async () => {
    respond = () => new Response(JSON.stringify({ pricePerUnitInUsdCents: null }), { status: 200 });
    await expect(estimateCostPerRow(BUILTIN_PROBES.company_data.spec, STANDARD_ORG)).rejects.toThrow(/no price/);
  });
});
