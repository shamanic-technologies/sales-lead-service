import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { fetchAnswerers } = await import("../../src/lib/answerer-client.js");

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];

function respond(status: number, body: unknown) {
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetchAnswerers", () => {
  it("asks nothing for no campaign", async () => {
    respond(200, { campaigns: [] });
    const read = await fetchAnswerers([]);
    expect(read).toEqual({ ok: true, data: new Map() });
    expect(calls).toHaveLength(0);
  });

  it("posts the deduplicated ids once and keys the answers by campaign", async () => {
    respond(200, {
      campaigns: [
        { ok: true, campaignId: "c1", answeredBy: null, absence: "no_answering_campaign", startableFeatureSlugs: [], candidate: null, candidateAnswersCampaignId: null },
        { ok: false, campaignId: "c2", status: 404, reason: "not_found", error: "no such campaign" },
      ],
    });
    const read = await fetchAnswerers(["c1", "c2", "c1"]);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/internal\/campaigns\/answerers$/);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ campaignIds: ["c1", "c2"] });
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.data.get("c1")).toMatchObject({ absence: "no_answering_campaign" });
      expect(read.data.get("c2")).toMatchObject({ ok: false, status: 404 });
    }
  });

  it("serves an outbound leg in its new spelling, leaves every other key as read", async () => {
    const campaign = (legKey: string, featureSlug: string | null) => ({
      campaignId: "x", legKey, status: "ongoing", featureSlug, acquisitionChannel: null, workflowSlug: null,
    });
    respond(200, {
      campaigns: [
        {
          ok: true, campaignId: "c1", absence: null, startableFeatureSlugs: [], candidateAnswersCampaignId: null,
          answeredBy: campaign("start_to_conversation", "sales-cold-email-outreach"),
          candidate: campaign("start_to_website_visit", "google-ads"),
        },
      ],
    });
    const read = await fetchAnswerers(["c1"]);
    expect(read.ok).toBe(true);
    if (read.ok) {
      const entry = read.data.get("c1");
      expect(entry).toMatchObject({
        answeredBy: { legKey: "lead_found_to_conversation" },
        candidate: { legKey: "start_to_website_visit" },
      });
    }
  });

  it("a non-2xx is a failed read, never an empty answer", async () => {
    respond(502, { error: "catalogue unreadable" });
    const read = await fetchAnswerers(["c1"]);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain("502");
  });

  it("an unreachable campaign-service is a failed read", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const read = await fetchAnswerers(["c1"]);
    expect(read.ok).toBe(false);
  });
});
