/**
 * CLIENT-SENTIMENT-1027: who is a client, what Jev reads, that a judgment is frozen once, and the read's
 * "not final yet" markers (never a fake 0).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async (url: string, init: { body: string; headers: Record<string, string> }) => {
    sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ judge: "jev", model: "jev-1.13.0", answers: { answer: { choice: "positive", confidence: 0.9 } } }), { status: 200 });
  },
}));
const executed: string[] = [];
const dbRows: unknown[][] = [];
vi.mock("../../src/db/index.js", () => ({
  db: {
    execute: async (q: { queryChunks?: unknown[] }) => {
      executed.push(JSON.stringify(q.queryChunks ?? q));
      return dbRows.shift() ?? [];
    },
  },
}));
const blocks = new Map<string, { tags: string[] }>();
vi.mock("../../src/lib/relationship-read.js", () => ({ loadRelationshipsAt: async () => blocks }));
vi.mock("../../src/lib/org-members.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/org-members.js")>()),
  loadOrgMemberKeys: async () => new Set(["owner@brand.test"]),
}));

const cs = await import("../../src/lib/client-sentiment.js");
const H = "33333333-3333-4333-8333-333333333333";
const SCOPE = { orgId: "o", brandId: "b" };

beforeEach(() => {
  sent.length = 0;
  executed.length = 0;
  dbRows.length = 0;
  blocks.clear();
});

describe("isClientRelation", () => {
  const none = new Set<string>();
  it("customer yes = client", () => expect(cs.isClientRelation({ tags: ["customer"] }, ["a@x.test"], none)).toBe(true));
  it("no customer tag = not a client (a lead, a personal contact)", () => {
    expect(cs.isClientRelation({ tags: ["prospect"] }, ["a@x.test"], none)).toBe(false);
    expect(cs.isClientRelation(undefined, ["a@x.test"], none)).toBe(false);
  });
  it("team wins over customer", () => expect(cs.isClientRelation({ tags: ["customer", "team"] }, [], none)).toBe(false));
  it("a staff address or an own-org member is never a client", () => {
    expect(cs.isClientRelation({ tags: ["customer"] }, ["kevin.lourd+dougs@gmail.com"], none)).toBe(false);
    expect(cs.isClientRelation({ tags: ["customer"] }, ["Owner+test@brand.test"], new Set(["owner@brand.test"]))).toBe(false);
  });
});

describe("judgedThroughOf", () => {
  it("stops at the first unjudged message", () => {
    expect(
      cs.judgedThroughOf([
        { at: "2026-10-01T00:00:00.000Z", judged: true },
        { at: "2026-10-03T00:00:00.000Z", judged: false },
        { at: "2026-10-02T00:00:00.000Z", judged: true },
      ]),
    ).toBe("2026-10-02T00:00:00.000Z");
  });
  it("none judged = null", () => expect(cs.judgedThroughOf([{ at: "2026-10-01T00:00:00.000Z", judged: false }])).toBeNull());
});

describe("judgeScope", () => {
  it("judges each unjudged client message once, platform support, frozen with ON CONFLICT DO NOTHING", async () => {
    blocks.set(`${H}|`, { tags: ["customer"] });
    dbRows.push(
      [{ human_id: H, company_key: "", emails: ["chaim@x.test"], contact_points: ["cp1"] }],
      [{ fact_id: "f1", contact_point: "cp1", source: "matrix", channel: "whatsapp", subject: null, text: "Nice, thanks Kevin, first replies already in!", at: "2026-10-27 18:00:00+00" }],
      [{ type: "message_out", at: "2026-10-27 17:50:00+00", subject: null, text: "Your campaign is live" }],
      [],
    );
    const r = await cs.judgeScope(SCOPE, 5);
    expect(r).toEqual({ judged: 1, positive: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toMatch(/\/internal\/platform-judgments$/);
    expect(sent[0].body.support).toEqual(cs.CLIENT_SENTIMENT_SUPPORT);
    expect(sent[0].headers["x-run-id"]).toBeUndefined();
    const q = (sent[0].body.questions as Record<string, { type: string; criteria: Record<string, string> }>).answer;
    expect(q.type).toBe("choice");
    expect(Object.keys(q.criteria).sort()).toEqual(["negative", "neutral", "positive"]);
    const state = sent[0].body.state as { thread: Array<{ from: string }>; message: { text: string } };
    expect(state.thread).toEqual([{ from: "brand", at: "2026-10-27T17:50:00.000Z", text: "Your campaign is live" }]);
    expect(state.message.text).toContain("first replies");
    expect(executed.at(-1)).toContain("ON CONFLICT (fact_id) DO NOTHING");
    // The unjudged read excludes judged facts: a second pass never re-asks the same message.
    expect(executed[1]).toContain("NOT EXISTS (SELECT 1 FROM client_sentiment_judgments j WHERE j.fact_id = f.fact_id)");
  });

  it("no client relation = nothing read, nothing judged", async () => {
    blocks.set(`${H}|`, { tags: ["prospect"] });
    dbRows.push([{ human_id: H, company_key: "", emails: ["lead@x.test"], contact_points: ["cp1"] }]);
    expect(await cs.judgeScope(SCOPE, 5)).toEqual({ judged: 0, positive: 0 });
    expect(sent).toHaveLength(0);
    expect(executed).toHaveLength(1);
  });
});

describe("readClientSentiment", () => {
  it("counts judged and unjudged per day, lists verdicts, never judges", async () => {
    blocks.set(`${H}|`, { tags: ["customer"] });
    dbRows.push(
      [{ human_id: H, company_key: "", emails: ["c@x.test"], contact_points: ["cp1"] }],
      [
        { fact_id: "f1", contact_point: "cp1", source: "matrix", channel: "whatsapp", at: "2026-10-26 10:00:00+00", sentiment: "positive", confidence: 0.9, model: "jev-1.13.0", judged_at: "2026-10-27 10:00:00+00", lead_ids: ["L1"] },
        { fact_id: "f2", contact_point: "cp1", source: "gmail", channel: null, at: "2026-10-26 12:00:00+00", sentiment: "negative", confidence: 0.8, model: "jev-1.13.0", judged_at: "2026-10-27 10:00:00+00", lead_ids: [] },
        { fact_id: "f3", contact_point: "cp1", source: "matrix", channel: "whatsapp", at: "2026-10-27 09:00:00+00", sentiment: null, confidence: null, model: null, judged_at: null, lead_ids: [] },
      ],
    );
    const r = await cs.readClientSentiment(SCOPE, { sentiment: "positive" });
    expect(sent).toHaveLength(0);
    expect(r.messages).toBe(3);
    expect(r.judged).toBe(2);
    expect(r.unjudged).toBe(1);
    expect(r.judgedThrough).toBe("2026-10-26T12:00:00.000Z");
    expect(r.counts).toEqual({ positive: 1, neutral: 0, negative: 1 });
    expect(r.days).toEqual([
      { day: "2026-10-26", positive: 1, neutral: 0, negative: 1, unjudged: 0 },
      { day: "2026-10-27", positive: 0, neutral: 0, negative: 0, unjudged: 1 },
    ]);
    expect(r.verdicts.map((v) => [v.messageId, v.channel, v.leadIds])).toEqual([["f1", "whatsapp", ["L1"]]]);
  });

  it("a brand with no client reads as zero messages (not unknown)", async () => {
    dbRows.push([]);
    const r = await cs.readClientSentiment(SCOPE);
    expect(r).toMatchObject({ messages: 0, judged: 0, unjudged: 0, judgedThrough: null, verdicts: [] });
  });
});
