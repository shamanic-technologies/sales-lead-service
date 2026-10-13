/**
 * A CRM contact pairs with its lead by human-service's humanId, against a REAL database: the fact's
 * `humanId` (crm-service#125) is read off the bronze copy, a fact with no contact row is keyed on the
 * human, the lead holding that human at the brand is the pair (through a merge alias too, the most
 * recent lead when the human changed company), and a human with no lead at the brand pairs nothing.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { crmFacts, leads } from "../../src/db/schema.js";
import { loadCrmFunnelEvents } from "../../src/lib/crm-fact-events.js";
import { pairByHuman } from "../../src/lib/crm-evidence-sync.js";
import { PEOPLE_FACTS_FEED } from "../../src/lib/crm-fact-feed.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("CRM contacts pair with leads by humanId", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const made: string[] = [];
  const factIds: string[] = [];

  afterAll(async () => {
    if (factIds.length) await db.delete(crmFacts).where(inArray(crmFacts.factId, factIds));
    if (made.length) await db.execute(sql`DELETE FROM leads_campaigns WHERE lead_id = ANY(${sql.param(made)}::uuid[])`);
    if (made.length) await db.delete(leads).where(inArray(leads.id, made));
  });

  async function leadAtBrand(humanId: string, createdAt: string): Promise<string> {
    const [l] = await db.insert(leads).values({ firstName: "x", humanId, createdAt: new Date(createdAt) }).returning({ id: leads.id });
    made.push(l.id);
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status)
      VALUES (${l.id}::uuid, ${`c-${randomUUID()}`}, ${orgId}, ${sql.param([brandId])}::text[], 'served')`);
    return l.id;
  }

  async function fact(type: string, crmContactId: string | null, humanId: string | null): Promise<void> {
    const factId = randomUUID();
    factIds.push(factId);
    await db.insert(crmFacts).values({
      factId,
      seq: BigInt(Math.floor(Math.random() * 1e15)),
      orgId,
      brandId,
      personKey: `email:${factId}@x.example`,
      crmContactId,
      emails: [`${factId}@x.example`],
      phones: [],
      type,
      occurredAt: new Date("2026-09-29T03:43:04Z"),
      dateBasis: "event",
      source: "distribute_platform",
      sourceRef: factId,
      payload: {},
      raw: humanId ? { humanId } : {},
    });
  }

  it("pairs by humanId, keys a contact-less fact on the human, and leaves an unknown human unpaired", async () => {
    await db.execute(sql`
      INSERT INTO crm_feed_cursors (feed, cursor, caught_up_at) VALUES (${PEOPLE_FACTS_FEED}, '0', now())
      ON CONFLICT (feed) DO UPDATE SET caught_up_at = COALESCE(crm_feed_cursors.caught_up_at, now())`);
    const lucas = randomUUID();
    const mover = randomUUID();
    const merged = randomUUID();
    const stranger = randomUUID();
    const lucasLead = await leadAtBrand(lucas, "2026-09-01T00:00:00Z");
    await leadAtBrand(mover, "2026-01-01T00:00:00Z");
    const moverNow = await leadAtBrand(mover, "2026-06-01T00:00:00Z");
    await db.execute(sql`INSERT INTO human_aliases (atomic_human_id, human_id, event_id) VALUES (${merged}::uuid, ${lucas}::uuid, 1)`);

    await fact("signup", null, lucas);
    const contact = randomUUID();
    await fact("signup", contact, mover);
    await fact("payment", randomUUID(), merged);
    await fact("signup", randomUUID(), stranger);

    const contacts = await loadCrmFunnelEvents(orgId, brandId);
    expect(contacts.find((c) => c.contactId === `human:${lucas}`)?.humanId).toBe(lucas);
    const pairs = await pairByHuman(orgId, brandId, contacts);
    expect(pairs.get(`human:${lucas}`)).toMatchObject({ matchedLeadId: lucasLead, matchMethod: "human", matchConfidence: "deterministic" });
    expect(pairs.get(contact)?.matchedLeadId).toBe(moverNow);
    expect([...pairs.values()].filter((p) => p.matchedLeadId === lucasLead)).toHaveLength(2);
    expect([...pairs.keys()].some((k) => contacts.find((c) => c.contactId === k)?.humanId === stranger)).toBe(false);
  });
});
