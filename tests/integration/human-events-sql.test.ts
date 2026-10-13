/**
 * Following human-service's events against a REAL database (client mocked): a fleet fact copied then
 * withdrawn, an org-scoped event ignored, a fleet merge moving every lead to the canonical human and
 * recording the second lead at one company as a duplicate (oldest survives, both ids kept), and the
 * cursor moving with the page.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";

const listHumanEvents = vi.fn();
const getHuman = vi.fn();
vi.mock("../../src/lib/human-identity-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/human-identity-client.js")>()),
  listHumanEvents: (...a: unknown[]) => listHumanEvents(...a),
  getHuman: (...a: unknown[]) => getHuman(...a),
}));

import { db } from "../../src/db/index.js";
import { leads } from "../../src/db/schema.js";
import { HUMAN_EVENTS_FEED, pullHumanEventsOnce } from "../../src/lib/human-events.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("human events follower", () => {
  const made: string[] = [];
  let seq = 900_000_000 + Math.floor(Math.random() * 1_000_000);
  const ev = (type: string, humanIds: string[], data: Record<string, unknown>, orgId: string | null = null) => ({
    id: String(++seq),
    type,
    orgId,
    humanIds,
    data,
    createdAt: new Date().toISOString(),
  });

  beforeEach(async () => {
    listHumanEvents.mockReset();
    getHuman.mockReset();
    await db.execute(sql`DELETE FROM crm_feed_cursors WHERE feed = ${HUMAN_EVENTS_FEED}`);
  });
  afterAll(async () => {
    if (made.length) await db.delete(leads).where(inArray(leads.id, made));
  });

  async function lead(humanId: string, companyId: string | null, createdAt: string): Promise<string> {
    const [l] = await db
      .insert(leads)
      .values({ firstName: "x", humanId, companyId, createdAt: new Date(createdAt) })
      .returning({ id: leads.id });
    made.push(l.id);
    return l.id;
  }

  it("copies a fleet fact, ignores an org's own event, then copies the withdrawal", async () => {
    const human = randomUUID();
    const factId = randomUUID();
    const orgFact = randomUUID();
    getHuman.mockResolvedValue({
      humanId: human,
      memberHumanIds: [human],
      emails: [],
      phones: [],
      facts: [{ factId, humanId: human, kind: "opt_out", statedByOrgId: null, source: "instantly-service", evidence: "e", statedAt: "2026-10-01T00:00:00.000Z" }],
    });
    const stated = ev("human.fact_stated", [human], { factId, humanId: human, kind: "opt_out", statedByOrgId: null });
    const orgOnly = ev("human.fact_stated", [human], { factId: orgFact, humanId: human, kind: "opt_out" }, randomUUID());
    listHumanEvents.mockResolvedValueOnce({ events: [stated, orgOnly], nextCursor: orgOnly.id, hasMore: false });
    await pullHumanEventsOnce();
    const copies = (await db.execute(sql`SELECT fact_id::text, kind, source, stated_at, withdrawn_at FROM human_fact_copies WHERE human_id = ${human}`)) as unknown as Array<Record<string, unknown>>;
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ fact_id: factId, kind: "opt_out", source: "instantly-service", withdrawn_at: null });
    const cursor = (await db.execute(sql`SELECT cursor, caught_up_at FROM crm_feed_cursors WHERE feed = ${HUMAN_EVENTS_FEED}`)) as unknown as Array<{ cursor: string; caught_up_at: unknown }>;
    expect(cursor[0].cursor).toBe(orgOnly.id);
    expect(cursor[0].caught_up_at).not.toBeNull();

    const withdrawn = ev("human.fact_withdrawn", [human], { factId, humanId: human, kind: "opt_out" });
    listHumanEvents.mockResolvedValueOnce({ events: [withdrawn], nextCursor: withdrawn.id, hasMore: false });
    await pullHumanEventsOnce();
    const after = (await db.execute(sql`SELECT withdrawn_at FROM human_fact_copies WHERE fact_id = ${factId}`)) as unknown as Array<{ withdrawn_at: unknown }>;
    expect(after[0].withdrawn_at).not.toBeNull();
  });

  it("moves leads to the merged human and records the second lead at one company, ids kept", async () => {
    const older = randomUUID();
    const younger = randomUUID();
    const companyA = randomUUID();
    const companyB = randomUUID();
    const a1 = await lead(older, companyA, "2026-01-01T00:00:00Z");
    const a2 = await lead(younger, companyA, "2026-02-01T00:00:00Z");
    const b1 = await lead(younger, companyB, "2026-03-01T00:00:00Z");
    getHuman.mockResolvedValue({ humanId: older, memberHumanIds: [older, younger], emails: [], phones: [], facts: [] });
    const linked = ev("human.linked", [older, younger], { relation: "same", scope: "fleet", basis: "shared_email" });
    listHumanEvents.mockResolvedValueOnce({ events: [linked], nextCursor: linked.id, hasMore: false });
    await pullHumanEventsOnce();

    const rows = (await db.execute(sql`SELECT id::text, human_id::text FROM leads WHERE id = ANY(${sql.param([a1, a2, b1])}::uuid[]) ORDER BY created_at`)) as unknown as Array<{ id: string; human_id: string }>;
    expect(rows.map((r) => r.id)).toEqual([a1, a2, b1]);
    expect(new Set(rows.map((r) => r.human_id))).toEqual(new Set([older]));
    const dups = (await db.execute(sql`SELECT lead_id::text, survivor_lead_id::text FROM lead_identity_duplicates WHERE human_id = ${older}`)) as unknown as Array<{ lead_id: string; survivor_lead_id: string }>;
    expect(dups).toEqual([{ lead_id: a2, survivor_lead_id: a1 }]);
    const alias = (await db.execute(sql`SELECT human_id::text FROM human_aliases WHERE atomic_human_id = ${younger}`)) as unknown as Array<{ human_id: string }>;
    expect(alias[0].human_id).toBe(older);
  });

  it("leaves the cursor where it was when a page fails", async () => {
    listHumanEvents.mockResolvedValueOnce({
      events: [ev("human.linked", [randomUUID()], { relation: "same", scope: "fleet" })],
      nextCursor: "123",
      hasMore: false,
    });
    getHuman.mockRejectedValue(new Error("human-service down"));
    await expect(pullHumanEventsOnce()).rejects.toThrow("human-service down");
    const cursor = (await db.execute(sql`SELECT cursor FROM crm_feed_cursors WHERE feed = ${HUMAN_EVENTS_FEED}`)) as unknown as unknown[];
    expect(cursor).toHaveLength(0);
  });
});
