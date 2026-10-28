import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// UNIBOX-FACT-LAG-1028: a fact crm-service emits must be readable in lead-service within about a minute.
// Reproduces the feed: the worker runs on its real timers; crm emits a fact at some instant after the first pull;
// the fact must be copied before CRM_FACT_MAX_LAG_MS has passed, whatever the instant within a tick.

const crmFeed: Array<{ seq: number; factId: string }> = [];
const fetchCrmFactsPage = vi.fn(async (cursor: string | null) => {
  const since = cursor === null ? 0 : Number(cursor);
  const facts = crmFeed.filter((f) => f.seq > since).map((f) => fact(f.factId, f.seq));
  return { facts, nextCursor: facts.length ? String(facts[facts.length - 1].seq) : String(since), hasMore: false };
});
vi.mock("../../src/lib/crm-client.js", () => ({
  fetchCrmFactsPage: (cursor: string | null, limit: number) => fetchCrmFactsPage(cursor, limit),
}));

const copied = new Map<string, number>();
let storedCursor: string | null = null;
vi.mock("../../src/db/index.js", () => ({
  db: {
    // Every cursor read: the people feed's position; the contact-point re-walk reads it as finished.
    select: () => ({ from: () => ({ where: async () => [{ cursor: storedCursor, caughtUpAt: new Date(0) }] }) }),
    transaction: async (fn: (tx: unknown) => Promise<number>) =>
      fn({
        insert: () => ({
          values: (v: unknown) => ({
            onConflictDoNothing: () => ({
              returning: async () => {
                const rows = v as Array<{ factId: string }>;
                for (const r of rows) if (!copied.has(r.factId)) copied.set(r.factId, Date.now());
                return rows.map(() => ({}));
              },
            }),
            onConflictDoUpdate: async () => {
              storedCursor = (v as { cursor: string }).cursor;
            },
          }),
        }),
      }),
  },
}));

const { startCrmFactFeedWorker, CRM_FACT_MAX_LAG_MS, CRM_FACT_FEED_INTERVAL_MS } = await import("../../src/lib/crm-fact-feed.js");

function fact(factId: string, seq: number) {
  return {
    factId,
    seq: String(seq),
    orgId: "org-1",
    brandId: "brand-1",
    personKey: "tari@example.com",
    sourceContactId: null,
    crmContactId: null,
    fullName: null,
    emails: ["tari@example.com"],
    phones: [],
    type: "payment",
    occurredAt: "2026-10-28T05:00:39.000Z",
    dateBasis: "charged_at",
    source: "stripe",
    sourceRef: `ch_${seq}`,
    payload: { status: "failed" },
    contactPoint: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  crmFeed.length = 0;
  copied.clear();
  storedCursor = null;
});
afterEach(() => vi.useRealTimers());

describe("crm fact feed lag (UNIBOX-FACT-LAG-1028)", () => {
  it("polls well inside the one-minute bound", () => {
    expect(CRM_FACT_FEED_INTERVAL_MS).toBeLessThanOrEqual(CRM_FACT_MAX_LAG_MS / 2);
  });

  it.each([0, 1_000, 7_500, 14_999])(
    "copies a fact crm emits %ims into a tick within a minute",
    async (offset) => {
      startCrmFactFeedWorker();
      await vi.advanceTimersByTimeAsync(5 * 60_000); // past the first pull, in steady state
      await vi.advanceTimersByTimeAsync(offset);
      const emittedAt = Date.now();
      crmFeed.push({ seq: 803046, factId: `refused-charge-${offset}` });
      await vi.advanceTimersByTimeAsync(CRM_FACT_MAX_LAG_MS);
      const at = copied.get(`refused-charge-${offset}`);
      expect(at).toBeDefined();
      expect(at! - emittedAt).toBeLessThanOrEqual(CRM_FACT_FEED_INTERVAL_MS);
    },
  );
});
