/**
 * LEAD-CHANGES-INVALID-EMAIL-1016: one malformed address in a scope must not take the lead changes
 * feed down for everyone. In prod (2026-10-16 ~12:10 UTC) the Unibox intake filed two customer.io
 * unsubscribe addresses (`32.<base32>====@unsubscribe2.customer.io`); email-gateway's `/orgs/status`
 * refuses a batch carrying any address its `z.string().email()` rejects (400 `Invalid email address`),
 * and the feed answered 502 on every read.
 *
 * Real database, real routes, real gateway CLIENT: only `fetch` is stubbed, as a gateway that
 * validates exactly like the deployed one (the whole batch is a 400 when one address is malformed).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

const gatewayEmail = z.string().email();
const delivered: Record<string, Record<string, unknown>> = {
  "valid@feed-malformed.test": { contacted: true, sent: true, delivered: true, firstSentAt: "2026-02-01T00:00:00.000Z" },
};
const askedEmails: string[][] = [];

vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
  const href = String(url);
  if (!href.endsWith("/orgs/status")) throw new Error(`unexpected fetch in test: ${href}`);
  const body = JSON.parse(String(init?.body)) as { items: Array<{ email: string }> };
  askedEmails.push(body.items.map((i) => i.email));
  const refused = body.items.filter((i) => !gatewayEmail.safeParse(i.email).success);
  if (refused.length > 0) {
    const error = { error: "Invalid request", details: { fieldErrors: { items: refused.map(() => "Invalid email address") } } };
    return new Response(JSON.stringify(error), { status: 400 });
  }
  const results = body.items
    .filter((i) => delivered[i.email])
    .map((i) => ({ email: i.email, broadcast: { brand: delivered[i.email] } }));
  return new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });
});

vi.mock("../../src/lib/campaign-identity-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/campaign-identity-client.js")>()),
  resolveCampaignFamily: (campaignId: string) => Promise.resolve([campaignId]),
}));

const { db, sql } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns } = await import("../../src/db/schema.js");
const leadsRoutes = (await import("../../src/routes/leads.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("the lead change feed when a lead carries a malformed address", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const campaignId = `itest-feed-malformed-${randomUUID()}`;
  const app = express();
  app.use(express.json());
  app.use(leadsRoutes);
  const leadIds: string[] = [];
  const rowOf: Record<string, string> = {};

  async function seed(key: string, email: string, at: string) {
    const [lead] = await db
      .insert(leads)
      .values({ firstName: key, lastName: "Test", name: `${key} Test` })
      .returning({ id: leads.id });
    leadIds.push(lead.id);
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: email, source: "itest" });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({ leadId: lead.id, campaignId, orgId, brandIds: [brandId], status: "served", servedAt: new Date(at), createdAt: new Date(at) })
      .returning({ id: leadsCampaigns.id });
    rowOf[key] = row.id;
  }

  beforeAll(async () => {
    await seed("Valid", "valid@feed-malformed.test", "2026-01-01T00:00:00Z");
    // The two prod addresses' shape: base32 padding `=` in the local part, which zod's email refuses.
    await seed("BadOne", "32.mrtvistno5kueqkng5lxqukqjuyxgvkeifng2z2mfvxwy3ckpjghuwkpnjcvgx2jjztt2pi=@unsubscribe2.customer.io", "2026-01-02T00:00:00Z");
    await seed("BadTwo", "32.kjfxeu2co5kucqk2offe4tkdkvus2sklkzcwkm3wge2girtxhu6q====@unsubscribe2.customer.io", "2026-01-03T00:00:00Z");
  }, 60_000);

  afterAll(async () => {
    await sql`DELETE FROM lead_change_feeds WHERE org_id = ${orgId}`;
    await sql`DELETE FROM lead_read_changes WHERE org_id = ${orgId}`;
    await sql`DELETE FROM lead_delivery_evidence WHERE org_id = ${orgId}`;
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.orgId, orgId));
    await db.delete(leads).where(inArray(leads.id, leadIds));
  });

  it("answers 200, the valid address keeps its delivery status, the malformed ones are named loudly", async () => {
    const errors = vi.spyOn(console, "error");
    const res = await request(app)
      .get(`/orgs/leads/changes?brandId=${brandId}`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", orgId);

    expect(res.status).toBe(200);
    expect(res.body.full).toBe(true);
    const rows = new Map((res.body.leads as Array<{ id: string } & Record<string, unknown>>).map((r) => [r.id, r]));
    expect(rows.size).toBe(3);
    expect(rows.get(rowOf.Valid)).toMatchObject({ contacted: true, sent: true, delivered: true });
    expect(rows.get(rowOf.BadOne)).toMatchObject({ contacted: false, sent: false });
    expect(rows.get(rowOf.BadTwo)).toMatchObject({ contacted: false, sent: false });

    // The gateway was never handed a malformed address.
    expect(askedEmails.flat()).toContain("valid@feed-malformed.test");
    expect(askedEmails.flat().some((e) => e.includes("customer.io"))).toBe(false);

    // Each skipped address is logged with the lead it belongs to.
    const skipped = errors.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("delivery status SKIPPED"));
    expect(skipped.some((m) => m.includes(leadIds[1]) && m.includes("unsubscribe2.customer.io"))).toBe(true);
    expect(skipped.some((m) => m.includes(leadIds[2]) && m.includes("unsubscribe2.customer.io"))).toBe(true);
    errors.mockRestore();
  });
});
