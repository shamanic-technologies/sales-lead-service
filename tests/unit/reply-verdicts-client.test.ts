import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  INSTANTLY_SERVICE_URL: "https://instantly.test",
  INSTANTLY_SERVICE_API_KEY: "k",
}));

import {
  fetchReplyVerdicts,
  parseReplyVerdictsBody,
  ReplyVerdictsUnavailableError,
} from "../../src/lib/reply-verdicts-client.js";

const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe("reply-verdicts client — instantly-service's locked contract, read fail-loud", () => {
  it("asks org-scoped, in bounded batches, each address once", async () => {
    fetchSpy.mockResolvedValue(ok({ replies: [] }));
    const emails = Array.from({ length: 1_500 }, (_, i) => `P${i}@x.com`);
    await fetchReplyVerdicts([...emails, "p0@x.com"], { orgId: "org-1" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://instantly.test/orgs/reply-verdicts/query");
    expect((init.headers as Record<string, string>)["x-org-id"]).toBe("org-1");
    const first = JSON.parse(init.body).emails as string[];
    const second = JSON.parse(fetchSpy.mock.calls[1][1].body).emails as string[];
    expect(first).toHaveLength(1_000);
    expect(first[0]).toBe("p0@x.com");
    expect(first.length + second.length).toBe(1_500);
  });

  it("asks nothing for no address", async () => {
    expect(await fetchReplyVerdicts([], { orgId: "org-1" })).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a 500 is an error, never an empty list", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 500, text: async () => "read failed" });
    await expect(fetchReplyVerdicts(["a@x.com"], { orgId: "o" })).rejects.toBeInstanceOf(
      ReplyVerdictsUnavailableError,
    );
  });

  it("unreachable is an error, never an empty list", async () => {
    fetchSpy.mockRejectedValue(new Error("boom"));
    await expect(fetchReplyVerdicts(["a@x.com"], { orgId: "o" })).rejects.toBeInstanceOf(
      ReplyVerdictsUnavailableError,
    );
  });

  it("a body that is not the contract is an error", async () => {
    fetchSpy.mockResolvedValue(ok({ items: [] }));
    await expect(fetchReplyVerdicts(["a@x.com"], { orgId: "o" })).rejects.toBeInstanceOf(
      ReplyVerdictsUnavailableError,
    );
  });

  it("parses a reply with and without a verdict", () => {
    const [judged, pending] = parseReplyVerdictsBody({
      replies: [
        {
          replyId: "ie:1",
          leadEmail: "a@x.com",
          instantlyCampaignId: "i",
          campaignId: "c",
          brandIds: ["b"],
          transport: "instantly",
          fromEmail: "a@x.com",
          subject: "Re",
          receivedAt: "2026-09-28T04:52:00.000Z",
          verdict: {
            kind: "some_kind",
            classification: "neutral",
            producerType: "model",
            producer: "m",
            attribution: "exact",
            confidence: 0.9,
            decidedAt: "2026-09-28T05:00:00.000Z",
            automatedAnswer: false,
            stopRequested: false,
            notOurTarget: true,
            handedToPerson: true,
          },
          verdictCount: 1,
        },
        { replyId: "ie:2", leadEmail: "a@x.com", receivedAt: "2026-09-29T00:00:00.000Z", verdict: null, verdictCount: 0 },
      ],
    });
    expect(judged.verdict?.classification).toBe("neutral");
    expect(judged.verdict?.notOurTarget).toBe(true);
    expect(judged.verdict?.handedToPerson).toBe(true);
    expect(pending.verdict).toBeNull();
    expect(pending.campaignId).toBeNull();
  });

  it("refuses a verdict missing one of instantly-service's required flags", () => {
    expect(() =>
      parseReplyVerdictsBody({
        replies: [
          {
            replyId: "x",
            leadEmail: "a@x.com",
            receivedAt: "2026-09-29T00:00:00.000Z",
            verdict: { kind: "k", classification: "neutral", automatedAnswer: false, stopRequested: false },
          },
        ],
      }),
    ).toThrow(/notOurTarget/);
  });

  it("refuses a verdict missing the hand-over flag", () => {
    expect(() =>
      parseReplyVerdictsBody({
        replies: [
          {
            replyId: "x",
            leadEmail: "a@x.com",
            receivedAt: "2026-09-29T00:00:00.000Z",
            verdict: {
              kind: "k",
              classification: "neutral",
              automatedAnswer: false,
              stopRequested: false,
              notOurTarget: false,
            },
          },
        ],
      }),
    ).toThrow(/handedToPerson/);
  });

  it("refuses a classification outside the coarse three", () => {
    expect(() =>
      parseReplyVerdictsBody({
        replies: [
          {
            replyId: "x",
            leadEmail: "a@x.com",
            receivedAt: "2026-09-29T00:00:00.000Z",
            verdict: { kind: "k", classification: "great" },
          },
        ],
      }),
    ).toThrow();
  });
});
