/**
 * The CRM evidence sync's funnel events, read off the fact-feed copy against a REAL database: never
 * from a copy still filling, a withdrawn fact no longer counts, a re-minted contact's facts move to
 * the new id, and nothing of another brand or org leaks in.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { ingestFactsPage, PEOPLE_FACTS_FEED } = await import("../../src/lib/crm-fact-feed.js");
const { loadCrmFunnelEvents, CrmFactFeedNotCaughtUpError } = await import("../../src/lib/crm-fact-events.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("CRM funnel events off the fact-feed copy", () => {
  const org = randomUUID();
  const brand = randomUUID();
  const base = Math.floor(Math.random() * 1e12) * 10;
  let n = 0;
  let saved: Array<{ cursor: string; caught_up_at: unknown }> = [];

  function fact(over: Record<string, unknown> = {}) {
    n += 1;
    return {
      factId: randomUUID(),
      seq: String(base + n),
      orgId: org,
      brandId: brand,
      personKey: "email:ann@example.com",
      emails: ["ann@example.com"],
      phones: [],
      fullName: "Ann Example",
      sourceContactId: "ghl-1",
      crmContactId: "c-old",
      type: "sale",
      occurredAt: "2026-05-01T10:00:00.000Z",
      dateBasis: "changed_at",
      source: "gohighlevel",
      sourceRef: "opp-1",
      payload: { via: "status", amountMinor: 50000 },
      ...over,
    };
  }

  beforeAll(async () => {
    saved = (await db.execute(sql`SELECT cursor, caught_up_at FROM crm_feed_cursors WHERE feed = ${PEOPLE_FACTS_FEED}`)) as never;
    await db.execute(sql`DELETE FROM crm_feed_cursors WHERE feed = ${PEOPLE_FACTS_FEED}`);
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM crm_facts WHERE org_id IN (${org}, ${"other-" + org})`);
    await db.execute(sql`DELETE FROM crm_feed_cursors WHERE feed = ${PEOPLE_FACTS_FEED}`);
    for (const s of saved) {
      await db.execute(sql`INSERT INTO crm_feed_cursors (feed, cursor, caught_up_at) VALUES (${PEOPLE_FACTS_FEED}, ${s.cursor}, ${s.caught_up_at as string | null})`);
    }
  });

  it("refuses to read a copy that has never reached the end of the feed", async () => {
    const sale = fact();
    await ingestFactsPage({ facts: [sale], nextCursor: sale.seq, hasMore: true });
    await expect(loadCrmFunnelEvents(org, brand)).rejects.toBeInstanceOf(CrmFactFeedNotCaughtUpError);
  });

  it("reads the brand's funnel facts once caught up, nothing else, and drops withdrawn ones", async () => {
    const booked = fact({ type: "meeting_booked", sourceRef: "appt-1", payload: { via: "appointment", startsAt: null } });
    const visit = fact({ type: "website_visit", sourceRef: "s-1", payload: {} });
    const otherBrand = fact({ brandId: randomUUID() });
    const otherOrg = fact({ orgId: "other-" + org });
    const lost = fact({ type: "deal_lost", sourceRef: "opp-2" });
    const gone = fact({ type: "withdrawn", withdrawnOf: lost.factId, occurredAt: null, dateBasis: "none", source: "crm", crmContactId: "c-old", payload: { reason: "vendor_record_changed" } });
    await ingestFactsPage({ facts: [booked, visit, otherBrand, otherOrg, lost, gone], nextCursor: gone.seq, hasMore: false });

    const contacts = await loadCrmFunnelEvents(org, brand);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].contactId).toBe("c-old");
    expect(contacts[0].events.map((e) => [e.step, e.sourceId, e.occurredAt])).toEqual([
      ["sale", "opp-1", "2026-05-01T10:00:00.000Z"],
      ["meeting_booked", "appt-1", "2026-05-01T10:00:00.000Z"],
    ]);
  });

  it("moves a re-minted contact's facts to the new crm contact id", async () => {
    const rows = (await db.execute(sql`
      SELECT fact_id FROM crm_facts WHERE org_id = ${org} AND brand_id = ${brand} AND crm_contact_id = 'c-old' AND type IN ('sale', 'meeting_booked')
    `)) as unknown as Array<{ fact_id: string }>;
    const page = rows.flatMap((r) => [
      fact({ type: "withdrawn", withdrawnOf: r.fact_id, occurredAt: null, dateBasis: "none", source: "crm", payload: { reason: "crm_contact_reminted" } }),
    ]);
    page.push(fact({ crmContactId: "c-new" }), fact({ crmContactId: "c-new", type: "meeting_booked", sourceRef: "appt-1", payload: { via: "appointment" } }));
    await ingestFactsPage({ facts: page, nextCursor: page[page.length - 1].seq, hasMore: false });

    const contacts = await loadCrmFunnelEvents(org, brand);
    expect(contacts.map((c) => [c.contactId, c.events.map((e) => e.step)])).toEqual([["c-new", ["sale", "meeting_booked"]]]);
  });
});
