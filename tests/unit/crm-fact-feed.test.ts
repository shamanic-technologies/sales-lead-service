import { describe, it, expect, vi, beforeEach } from "vitest";

// The bronze copy of crm-service's people fact feed: a COPY, so a fact the contract does not
// describe fails the page loud (the cursor must not move past a fact we could not keep), a page and
// its cursor move together, and the walk ends exactly when crm says there is nothing more.

const fetchCrmFactsPage = vi.fn();
vi.mock("../../src/lib/crm-client.js", () => ({
  fetchCrmFactsPage: (...args: unknown[]) => fetchCrmFactsPage(...args),
}));

const ingested: Array<{ facts: unknown[]; nextCursor: string | null }> = [];
let storedCursor: string | null = null;
vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => (storedCursor === null ? [] : [{ cursor: storedCursor }]) }) }),
    transaction: async (fn: (tx: unknown) => Promise<number>) => {
      const tx = {
        insert: () => ({
          values: (v: unknown) => ({
            onConflictDoNothing: () => ({
              returning: async () => {
                const rows = v as unknown[];
                ingested.push({ facts: rows, nextCursor: null });
                return rows.map(() => ({}));
              },
            }),
            onConflictDoUpdate: async () => {
              storedCursor = (v as { cursor: string }).cursor;
            },
          }),
        }),
      };
      return fn(tx);
    },
  },
}));

const { parseCrmFact, pullCrmFacts, CrmFactParseError } = await import("../../src/lib/crm-fact-feed.js");

function fact(over: Record<string, unknown> = {}) {
  return {
    factId: "f-1",
    seq: "1",
    orgId: "org-1",
    brandId: "brand-1",
    personKey: "a@example.com",
    sourceContactId: "ghl-1",
    crmContactId: "0b6c8d0e-1111-4222-8333-944455556666",
    fullName: "Ann Example",
    emails: ["a@example.com"],
    phones: [],
    type: "meeting_booked",
    occurredAt: "2026-10-01T10:00:00.000Z",
    dateBasis: "booked_at",
    source: "gohighlevel",
    sourceRef: "appt-1",
    payload: { calendarName: "Demo", startsAt: "2026-10-02T10:00:00.000Z", via: "appointment" },
    ...over,
  };
}

beforeEach(() => {
  fetchCrmFactsPage.mockReset();
  ingested.length = 0;
  storedCursor = null;
});

describe("reading one fact off the wire", () => {
  it("keeps every field the contract names, verbatim", () => {
    const f = parseCrmFact(fact());
    expect(f).toMatchObject({ factId: "f-1", seq: "1", sourceContactId: "ghl-1", fullName: "Ann Example", withdrawnOf: null });
  });

  it("keeps a NULL date as null, never a stand-in", () => {
    expect(parseCrmFact(fact({ occurredAt: null })).occurredAt).toBeNull();
  });

  it("keeps a fact type it does not read yet: naming facts is crm-service's", () => {
    expect(parseCrmFact(fact({ type: "call_logged" })).type).toBe("call_logged");
  });

  it.each([
    ["no sourceContactId", { sourceContactId: undefined }],
    ["no fullName", { fullName: undefined }],
    ["no crmContactId", { crmContactId: undefined }],
    ["a seq that is not an integer", { seq: "1.5" }],
    ["an occurredAt that is not a date", { occurredAt: "yesterday" }],
    ["emails that are not strings", { emails: [1] }],
    ["a payload that is not an object", { payload: [] }],
    ["a withdrawal naming nothing", { type: "withdrawn" }],
  ])("refuses a fact with %s", (_label, over) => {
    const raw = fact(over);
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete (raw as Record<string, unknown>)[k];
    expect(() => parseCrmFact(raw)).toThrow(CrmFactParseError);
  });
});

describe("walking the feed", () => {
  it("starts from the beginning, moves the cursor with each page, and stops when crm has no more", async () => {
    fetchCrmFactsPage
      .mockResolvedValueOnce({ facts: [fact()], nextCursor: "c1", hasMore: true })
      .mockResolvedValueOnce({ facts: [fact({ factId: "f-2", seq: "2" })], nextCursor: "c2", hasMore: false });
    const r = await pullCrmFacts();
    expect(fetchCrmFactsPage.mock.calls.map((c) => c[0])).toEqual([null, "c1"]);
    expect(r).toMatchObject({ pages: 2, received: 2, inserted: 2, budgetReached: false });
    expect(storedCursor).toBe("c2");
  });

  it("resumes from the stored cursor", async () => {
    storedCursor = "c9";
    fetchCrmFactsPage.mockResolvedValueOnce({ facts: [], nextCursor: "c9", hasMore: false });
    await pullCrmFacts();
    expect(fetchCrmFactsPage).toHaveBeenCalledWith("c9", expect.any(Number));
  });

  it("writes nothing and keeps the cursor when one fact of the page is unreadable", async () => {
    storedCursor = "c0";
    fetchCrmFactsPage.mockResolvedValueOnce({ facts: [fact(), { factId: "broken" }], nextCursor: "c1", hasMore: false });
    await expect(pullCrmFacts()).rejects.toThrow(CrmFactParseError);
    expect(ingested).toHaveLength(0);
    expect(storedCursor).toBe("c0");
  });

  it("refuses to loop when crm says there is more but does not move its cursor", async () => {
    storedCursor = "c1";
    fetchCrmFactsPage.mockResolvedValue({ facts: [], nextCursor: "c1", hasMore: true });
    await expect(pullCrmFacts()).rejects.toThrow(/did not move its cursor/);
  });

  it("stops on its page budget and says so", async () => {
    let n = 0;
    fetchCrmFactsPage.mockImplementation(async () => ({ facts: [], nextCursor: `c${++n}`, hasMore: true }));
    const r = await pullCrmFacts(3);
    expect(r).toMatchObject({ pages: 3, budgetReached: true });
  });
});
