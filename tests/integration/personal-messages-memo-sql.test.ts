/**
 * The kept personal-messages answer (personal-messages-memo.ts) against a REAL database: after every
 * kind of change it must hold EXACTLY what the full statement (`readPersonalMessages`) returns — a new
 * message, a message naming a lead by phone, a new contact method, a new serve into the brand, a lead
 * leaving the brand, a withdrawal. A mocked `sql` compiles none of the GIN lookups or the change log.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const { db, sql } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns } = await import("../../src/db/schema.js");
const { readPersonalMessages } = await import("../../src/lib/personal-messages.js");
const { readPersonalMessagesKept, clearPersonalMessagesMemo } = await import("../../src/lib/personal-messages-memo.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("kept personal messages == the full statement", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const otherBrand = randomUUID();
  const campaignId = `itest-pm-${randomUUID()}`;
  const leadIds: string[] = [];
  const facts: string[] = [];

  async function lead(email: string | null, phone: string | null, brand: string | null): Promise<string> {
    const [row] = await db.insert(leads).values({ firstName: "P", lastName: "M", name: "P M" }).returning({ id: leads.id });
    leadIds.push(row.id);
    if (email) await db.insert(leadContactMethods).values({ leadId: row.id, channel: "email", value: email, source: "itest" });
    if (phone) await db.insert(leadContactMethods).values({ leadId: row.id, channel: "phone", value: phone, source: "itest" });
    if (brand) {
      await db.insert(leadsCampaigns).values({ leadId: row.id, campaignId, orgId, brandIds: [brand], status: "served", servedAt: new Date() });
    }
    return row.id;
  }

  async function fact(opts: { type: string; emails?: string[]; phones?: string[]; at?: string; withdrawnOf?: string; text?: string }) {
    const id = `itest-pm-fact-${randomUUID()}`;
    facts.push(id);
    await sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, withdrawn_of, raw)
      VALUES (${id}, (SELECT COALESCE(max(seq), 0) + 1 FROM crm_facts), ${orgId}, ${brandId}, ${"pk"}, ${opts.emails ?? []}::text[], ${opts.phones ?? []}::text[], ${opts.type},
              ${opts.at ?? "2026-11-01T10:00:00Z"}::timestamptz, 'stated', 'matrix', ${id},
              ${JSON.stringify({ channel: "whatsapp", text: opts.text ?? "hello" })}::jsonb, ${opts.withdrawnOf ?? null}, '{}'::jsonb)
    `;
    return id;
  }

  async function same() {
    const full = await readPersonalMessages(orgId, brandId);
    const keptRows = await readPersonalMessagesKept(orgId, brandId);
    expect(keptRows).toEqual(full);
    return full;
  }

  let ann = "";
  let bob = "";
  beforeAll(async () => {
    clearPersonalMessagesMemo();
    ann = await lead("Ann@PM.test", null, brandId);
    bob = await lead(null, "+15550001", brandId);
    await fact({ type: "message_in", emails: ["ann@pm.test"], at: "2026-11-01T09:00:00Z" });
    await fact({ type: "message_out", phones: ["+15550001"], at: "2026-11-01T09:05:00Z" });
  }, 60_000);

  afterAll(async () => {
    await sql`DELETE FROM crm_facts WHERE fact_id = ANY(${facts}::text[])`;
    await sql`DELETE FROM lead_read_changes WHERE org_id = ${orgId}`;
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.orgId, orgId));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  });

  it("starts from the full answer", async () => {
    expect((await same()).map((m) => m.leadId).sort()).toEqual([ann, bob].sort());
  });

  it("adds a new message, by email and by phone, and ignores one naming nobody of the brand", async () => {
    await fact({ type: "message_in", emails: ["ANN@pm.test"], at: "2026-11-02T09:00:00Z", text: "second" });
    await fact({ type: "message_in", phones: ["+15550001"], at: "2026-11-02T09:01:00Z" });
    await fact({ type: "message_in", emails: ["stranger@pm.test"], at: "2026-11-02T09:02:00Z" });
    expect(await same()).toHaveLength(4);
  });

  it("follows a lead who gains an address, a lead newly served into the brand, and one who leaves it", async () => {
    await db.insert(leadContactMethods).values({ leadId: bob, channel: "email", value: "bob@pm.test", source: "itest" });
    await fact({ type: "message_in", emails: ["bob@pm.test"], at: "2026-11-03T09:00:00Z" });
    const carl = await lead("carl@pm.test", null, otherBrand);
    await fact({ type: "message_in", emails: ["carl@pm.test"], at: "2026-11-03T09:01:00Z" });
    expect((await same()).some((m) => m.leadId === carl)).toBe(false);
    await db.insert(leadsCampaigns).values({ leadId: carl, campaignId: `${campaignId}-2`, orgId, brandIds: [brandId], status: "served", servedAt: new Date() });
    expect((await same()).some((m) => m.leadId === carl)).toBe(true);
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.leadId, ann));
    expect((await same()).some((m) => m.leadId === ann)).toBe(false);
  });

  it("drops a withdrawn message", async () => {
    const id = await fact({ type: "message_in", emails: ["carl@pm.test"], at: "2026-11-04T09:00:00Z" });
    expect((await same()).some((m) => m.factId === id)).toBe(true);
    await fact({ type: "withdrawn", withdrawnOf: id, at: "2026-11-04T09:30:00Z" });
    expect((await same()).some((m) => m.factId === id)).toBe(false);
  });
});
