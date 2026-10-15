import { afterEach, describe, expect, it, vi } from "vitest";
import { askAudienceFit, readVerdict } from "../../src/lib/audience-fit-client.js";

// STILL-FITS-1012: human-service's verdict on a stocked find is read strictly; nothing defaults to "fits".
describe("audience fit client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads fits / no longer fits with the owner's reason", () => {
    expect(readVerdict({ fits: true }, 200)).toEqual({ fits: true });
    expect(readVerdict({ fits: false, reason: " Answered on WhatsApp " }, 200)).toEqual({ fits: false, reason: "Answered on WhatsApp" });
  });

  it("refuses a verdict it cannot read", () => {
    expect(() => readVerdict({}, 200)).toThrow(/without a fits verdict/);
    expect(() => readVerdict({ fits: "yes" }, 200)).toThrow(/without a fits verdict/);
    expect(() => readVerdict({ fits: false }, 200)).toThrow(/without a reason/);
    expect(() => readVerdict(null, 200)).toThrow();
  });

  it("a person human-service cannot judge is set aside in its words, never fits", async () => {
    const words = "The brand's CRM holds no person at this address, so this audience cannot say whether they still fit";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: words, code: "person_unknown_to_crm" }), { status: 422 })));
    await expect(
      askAudienceFit({ audienceId: "a", brandId: "b", email: "x@y.z", personId: null }, { orgId: "o" }),
    ).resolves.toEqual({ fits: false, reason: words });
  });

  it("a non-2xx from human-service throws, never fits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("audience not found", { status: 404 })));
    await expect(
      askAudienceFit({ audienceId: "a", brandId: "b", email: "x@y.z", personId: null }, { orgId: "o" }),
    ).rejects.toThrow(/404/);
  });

  it("carries the pipe's stepFilter verbatim; absent = today's body (CRM-WARM-NURTURE-1015)", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(init.body as string);
      return new Response(JSON.stringify({ fits: true }), { status: 200 });
    }));
    const stepFilter = { notReached: ["sale"] };
    await askAudienceFit({ audienceId: "a", brandId: "b", email: "x@y.z", personId: null, stepFilter }, { orgId: "o" });
    await askAudienceFit({ audienceId: "a", brandId: "b", email: "x@y.z", personId: null }, { orgId: "o" });
    expect(JSON.parse(bodies[0])).toEqual({ orgId: "o", audienceId: "a", brandId: "b", email: "x@y.z", personId: null, stepFilter });
    expect(bodies[1]).toBe(JSON.stringify({ orgId: "o", audienceId: "a", brandId: "b", email: "x@y.z", personId: null }));
  });

  it("a 400 on the stated stepFilter throws an AudienceFitError (status 400), never fits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":"unknown step"}', { status: 400 })));
    await expect(
      askAudienceFit({ audienceId: "a", brandId: "b", email: "x@y.z", personId: null, stepFilter: { reached: ["nope"] } }, { orgId: "o" }),
    ).rejects.toMatchObject({ name: "AudienceFitError", status: 400 });
  });
});
