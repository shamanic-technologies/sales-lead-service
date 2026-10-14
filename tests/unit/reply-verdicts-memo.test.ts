import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/config.js", () => ({
  INSTANTLY_SERVICE_URL: "https://instantly.test",
  INSTANTLY_SERVICE_API_KEY: "k",
}));

import {
  createReplyVerdictsMemo,
  fetchReplyVerdicts,
  ReplyVerdictsUnavailableError,
} from "../../src/lib/reply-verdicts-client.js";

const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

const reply = (replyId: string, leadEmail: string, receivedAt: string) => ({
  replyId,
  leadEmail,
  receivedAt,
  verdict: null,
  verdictCount: 0,
});
const ok = (replies: unknown[]) => ({ ok: true, status: 200, json: async () => ({ replies }) });
const asked = (call: number) => JSON.parse(fetchSpy.mock.calls[call][1].body).emails as string[];

describe("one request's reply-verdict reads, shared by its standing resolvers (DASH-LATENCY-1014)", () => {
  it("asks each address once per request; a second resolver of the same people asks nothing", async () => {
    const replies = [
      reply("r1", "a@x.com", "2026-10-01T00:00:00.000Z"),
      reply("r2", "A@x.com", "2026-10-02T00:00:00.000Z"),
      reply("r3", "b@x.com", "2026-10-03T00:00:00.000Z"),
    ];
    fetchSpy.mockResolvedValue(ok(replies));
    const memo = createReplyVerdictsMemo();

    const rows = await memo.fetch(["a@x.com", "b@x.com", "c@x.com"], { orgId: "o" });
    const cards = await memo.fetch(["b@x.com", "a@x.com"], { orgId: "o" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Same replies as asking directly, each person's in the order instantly-service gave them.
    fetchSpy.mockResolvedValue(ok(replies));
    const direct = await fetchReplyVerdicts(["a@x.com", "b@x.com", "c@x.com"], { orgId: "o" });
    expect(rows.map((r) => r.replyId)).toEqual(direct.map((r) => r.replyId));
    expect(cards.map((r) => r.replyId).sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("shares an answer still in flight, and asks only the addresses nobody asked yet", async () => {
    let release!: (v: unknown) => void;
    fetchSpy.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    fetchSpy.mockResolvedValueOnce(ok([reply("r9", "z@x.com", "2026-10-04T00:00:00.000Z")]));
    const memo = createReplyVerdictsMemo();

    const first = memo.fetch(["a@x.com"], { orgId: "o" });
    const second = memo.fetch(["a@x.com", "z@x.com"], { orgId: "o" });
    release(ok([reply("r1", "a@x.com", "2026-10-01T00:00:00.000Z")]));

    expect((await first).map((r) => r.replyId)).toEqual(["r1"]);
    expect((await second).map((r) => r.replyId)).toEqual(["r1", "r9"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(asked(0)).toEqual(["a@x.com"]);
    expect(asked(1)).toEqual(["z@x.com"]);
  });

  it("fails loud like the direct read, and does not remember the failure", async () => {
    fetchSpy.mockResolvedValueOnce({ ok: false, status: 500, text: async () => "read failed" });
    const memo = createReplyVerdictsMemo();
    await expect(memo.fetch(["a@x.com"], { orgId: "o" })).rejects.toBeInstanceOf(
      ReplyVerdictsUnavailableError,
    );
    fetchSpy.mockResolvedValueOnce(ok([reply("r1", "a@x.com", "2026-10-01T00:00:00.000Z")]));
    await Promise.resolve();
    expect((await memo.fetch(["a@x.com"], { orgId: "o" })).map((r) => r.replyId)).toEqual(["r1"]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
