/**
 * CATCHALL-SERVE-OPTION-1013: the pools (retry, source stock, released) read the pipe's email policy off the verdict
 * recorded on the lead's address. Raw SQL, so it runs against a real database (a mocked `sql` compiles nothing).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { leadContactMethods, leads, leadsCampaigns } from "../../src/db/schema.js";
import { loadRetryCandidates } from "../../src/lib/retry-pool.js";
import { registerServedEmail } from "../../src/lib/leads-registry.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("email policy on the pools, against a real database", () => {
  const campaignId = `itest-policy-${randomUUID()}`;
  const orgId = randomUUID();
  const brandId = randomUUID();
  const leadIds: Record<"valid" | "catchAll" | "legacy", string> = { valid: "", catchAll: "", legacy: "" };

  async function seed(verdict: string | null): Promise<string> {
    const [lead] = await db.insert(leads).values({ name: `itest ${randomUUID()}` }).returning({ id: leads.id });
    const owner = await registerServedEmail({
      leadId: lead.id,
      email: `policy-${randomUUID()}@itest.example`,
      status: null,
      source: "apollo",
      ...(verdict ? { verificationVerdict: verdict } : {}),
    });
    await db.insert(leadsCampaigns).values({
      leadId: owner,
      campaignId,
      orgId,
      brandIds: [brandId],
      status: "served",
      servedAt: new Date(Date.now() - 60_000),
    });
    return owner;
  }

  beforeAll(async () => {
    leadIds.valid = await seed("valid");
    leadIds.catchAll = await seed("catch_all");
    leadIds.legacy = await seed(null);
  });

  afterAll(async () => {
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.campaignId, campaignId));
    await db.delete(leadContactMethods).where(inArray(leadContactMethods.leadId, Object.values(leadIds)));
  });

  it("records the verdict on the address", async () => {
    const [row] = await db
      .select({ verdict: leadContactMethods.verificationVerdict })
      .from(leadContactMethods)
      .where(eq(leadContactMethods.leadId, leadIds.catchAll));
    expect(row.verdict).toBe("catch_all");
  });

  it("a pipe stating no policy (valid only) never gets the catch-all person back; unverified legacy rows stay", async () => {
    const got = await loadRetryCandidates({ orgId, campaignId, nowMs: Date.now() });
    expect(got.map((c) => c.leadId).sort()).toEqual([leadIds.valid, leadIds.legacy].sort());
  });

  it("valid_and_catch_all gets everyone", async () => {
    const got = await loadRetryCandidates({ orgId, campaignId, nowMs: Date.now(), acceptedEmails: "valid_and_catch_all" });
    expect(got.map((c) => c.leadId).sort()).toEqual([leadIds.valid, leadIds.catchAll, leadIds.legacy].sort());
  });

  it("a later serve stating no verdict leaves the recorded one in place", async () => {
    const [cm] = await db
      .select({ value: leadContactMethods.value })
      .from(leadContactMethods)
      .where(eq(leadContactMethods.leadId, leadIds.catchAll));
    await registerServedEmail({ leadId: leadIds.catchAll, email: cm.value, status: null, source: "apollo" });
    const [row] = await db
      .select({ verdict: leadContactMethods.verificationVerdict })
      .from(leadContactMethods)
      .where(eq(leadContactMethods.leadId, leadIds.catchAll));
    expect(row.verdict).toBe("catch_all");
  });
});
