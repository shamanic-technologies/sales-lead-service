/**
 * PEOPLE-SORT-BY-COMPANY-1023 against a REAL database: the Unibox list ordered by company keeps every person of one
 * company side by side across cursor pages, each named order is TOTAL (a walk visits every row exactly once), and the
 * default order is untouched.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const catalogue = {
  object: "step",
  lifecycleLadder: [
    { key: "lead_found", rank: 1, label: "Lead found" },
    { key: "engaged", rank: 3, label: "Engaged" },
    { key: "paid_client", rank: 7, label: "Paid client" },
  ],
  rows: [],
};
vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async (url: string) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const u = String(url);
    if (u.endsWith("/public/catalogue/steps")) return json(catalogue);
    if (u.includes("/sales-funnel-campaigns?")) return json({ salesFunnelCampaigns: [] });
    if (u.includes("/campaigns?")) return json({ campaigns: [] });
    throw new Error(`unexpected fetch ${u}`);
  },
}));

const { db } = await import("../../src/db/index.js");
const { readUniboxPage, resetLifecycleCatalogueCache, UNIBOX_SORTS } = await import("../../src/lib/unibox-model.js");
type Sort = (typeof UNIBOX_SORTS)[number];

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("unibox list orders", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const scope = { orgId, brandId };
  const bajaj = randomUUID();
  const lnt = randomUUID();
  const acme = randomUUID();
  const acmeTwin = randomUUID(); // another company also named "Acme": must not interleave with the first
  const nameless = randomUUID(); // a company known only by its id
  // Activity times are interleaved on purpose: by recency, Bajaj people are separated by L&T.
  const people: Array<{ human: string; company: string; name: string | null; domain?: string; rank: number | null; at: string }> = [];
  const add = (company: string, name: string | null, rank: number | null, at: string, domain?: string) =>
    people.push({ human: randomUUID(), company, name, rank, at, domain });

  beforeAll(async () => {
    resetLifecycleCatalogueCache();
    add(bajaj, "Bajaj Finserv", 3, "2026-10-20T10:00:00.000Z");
    add(lnt, "Larsen & Toubro", 1, "2026-10-20T09:00:00.000Z");
    add(bajaj, "Bajaj Finserv", null, "2026-10-20T08:00:00.000Z");
    add(acme, "Acme", 7, "2026-10-20T07:00:00.000Z");
    add(acmeTwin, "acme", 1, "2026-10-20T06:00:00.000Z");
    add(acme, "Acme", 3, "2026-10-20T05:00:00.000Z");
    add("", null, 3, "2026-10-20T04:00:00.000Z"); // no company
    add(nameless, null, null, "2026-10-20T03:00:00.000Z");
    add(lnt, "Larsen & Toubro", 1, "2026-10-20T02:00:00.000Z", "larsentoubro.com");
    add(bajaj, "Bajaj Finserv", 1, "2026-10-20T10:00:00.000Z"); // same instant as the first Bajaj person: tie on human
    add("", null, null, "2026-10-20T01:00:00.000Z");
    for (const p of people) {
      await db.execute(sql`
        INSERT INTO unibox_rows (org_id, brand_id, human_id, company_key, company_name, company_domain, lifecycle_key, lifecycle_rank,
          interest, conversation, contactability, fit, last_activity_at)
        VALUES (${orgId}, ${brandId}, ${p.human}::uuid, ${p.company}, ${p.name}, ${p.domain ?? null},
          ${p.rank === null ? null : catalogue.lifecycleLadder.find((r) => r.rank === p.rank)!.key}, ${p.rank},
          'not_asked', 'no_reply_yet', 'contactable', 'fit', ${p.at}::timestamptz)
      `);
    }
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM unibox_rows WHERE org_id = ${orgId}`);
  });

  async function walk(sort: Sort | undefined, limit: number): Promise<Array<{ humanId: string; companyKey: string; lastActivityAt: string; rank: number | null }>> {
    const out: Array<{ humanId: string; companyKey: string; lastActivityAt: string; rank: number | null }> = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const page = await readUniboxPage(scope, {}, sort === undefined ? { limit, cursor } : { limit, cursor, sort });
      expect(page.total).toBe(people.length);
      out.push(...page.rows.map((r) => ({ humanId: r.humanId, companyKey: r.companyKey, lastActivityAt: r.lastActivityAt, rank: r.lifecycle?.rank ?? null })));
      if (!page.nextCursor) return out;
      cursor = page.nextCursor;
    }
    throw new Error("walk did not end");
  }

  it.each(UNIBOX_SORTS.flatMap((s) => [1, 2, 3, 50].map((limit) => [s, limit] as const)))(
    "%s, %i per page: every row exactly once, same order whatever the page size",
    async (sort, limit) => {
      const rows = await walk(sort, limit);
      expect(rows.map((r) => r.humanId).sort()).toEqual(people.map((p) => p.human).sort());
      expect(rows.map((r) => r.humanId)).toEqual((await walk(sort, 50)).map((r) => r.humanId));
    },
  );

  it("company_asc: one company's people contiguous, named companies A-Z, a same-name twin never interleaved, no company last", async () => {
    const rows = await walk("company_asc", 2);
    const companies = rows.map((r) => r.companyKey);
    const runs = companies.filter((c, i) => i === 0 || companies[i - 1] !== c);
    expect(new Set(runs).size).toBe(runs.length); // each company appears as ONE contiguous run
    // acme / acme twin (by id), Bajaj, Larsen & Toubro, the id-only company, none.
    const acmes = [acme, acmeTwin].sort();
    expect(runs).toEqual([...acmes, bajaj, lnt, nameless, ""]);
    // Inside a company, most recent activity first.
    const bajajRows = rows.filter((r) => r.companyKey === bajaj);
    expect(bajajRows.map((r) => r.lastActivityAt)).toEqual([...bajajRows.map((r) => r.lastActivityAt)].sort().reverse());
  });

  it("company_desc: Z-A, no company still last", async () => {
    const companies = (await walk("company_desc", 3)).map((r) => r.companyKey);
    const runs = companies.filter((c, i) => i === 0 || companies[i - 1] !== c);
    expect(runs).toEqual([lnt, bajaj, ...[acme, acmeTwin].sort().reverse(), nameless, ""]);
  });

  it("stage_desc / stage_asc: by rung, no rung last in both", async () => {
    expect((await walk("stage_desc", 2)).map((r) => r.rank)).toEqual([7, 3, 3, 3, 1, 1, 1, 1, null, null, null]);
    expect((await walk("stage_asc", 2)).map((r) => r.rank)).toEqual([1, 1, 1, 1, 3, 3, 3, 7, null, null, null]);
  });

  it("last_touch_asc is the default order reversed; the default is unchanged", async () => {
    const def = (await walk(undefined, 2)).map((r) => r.humanId);
    expect((await walk("last_touch_asc", 2)).map((r) => r.humanId)).toEqual([...def].reverse());
    const times = (await walk(undefined, 50)).map((r) => r.lastActivityAt);
    expect(times).toEqual([...times].sort().reverse());
  });

  it("a cursor answers only the order it was issued for", async () => {
    const page = await readUniboxPage(scope, {}, { limit: 1, cursor: null, sort: "company_asc" });
    await expect(readUniboxPage(scope, {}, { limit: 1, cursor: page.nextCursor, sort: "stage_desc" })).rejects.toThrow(/another sort/);
    await expect(readUniboxPage(scope, {}, { limit: 1, cursor: page.nextCursor })).rejects.toThrow(/not one this endpoint issued/);
    const plain = await readUniboxPage(scope, {}, { limit: 1, cursor: null });
    await expect(readUniboxPage(scope, {}, { limit: 1, cursor: plain.nextCursor, sort: "company_asc" })).rejects.toThrow(/not one this endpoint issued/);
  });
});
