import { db, sql } from "../../src/db/index.js";
import { servedLeads, leadBuffer, cursors, idempotencyCache } from "../../src/db/schema.js";
import { eq } from "drizzle-orm";

export const TEST_API_KEY = "test-api-key";
// Randomize org ID per test run to prevent cross-run interference in shared Neon DB
const RUN_SUFFIX = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
export const TEST_ORG_ID = `test-org-${RUN_SUFFIX}`;
export const TEST_USER_ID = `test-user-${RUN_SUFFIX}`;
export const TEST_RUN_ID = `test-run-${RUN_SUFFIX}`;

export async function cleanupTestData(): Promise<void> {
  await db.delete(idempotencyCache).where(eq(idempotencyCache.orgId, TEST_ORG_ID));
  await db.delete(cursors).where(eq(cursors.orgId, TEST_ORG_ID));
  await db.delete(leadBuffer).where(eq(leadBuffer.orgId, TEST_ORG_ID));
  // Delete served_leads for current org + any test @example.com emails from prior runs
  await db.delete(servedLeads).where(eq(servedLeads.orgId, TEST_ORG_ID));
  await sql`DELETE FROM served_leads WHERE email LIKE '%@example.com'`;
  // Clean up leads/lead_emails created during test runs
  await sql`DELETE FROM lead_emails WHERE email LIKE '%@example.com'`;
  await sql`DELETE FROM leads WHERE id NOT IN (
    SELECT DISTINCT lead_id FROM served_leads WHERE lead_id IS NOT NULL
  ) AND id NOT IN (
    SELECT DISTINCT lead_id FROM lead_emails WHERE lead_id IS NOT NULL
  )`;
}

export async function closeDb(): Promise<void> {
  await sql.end();
}

export function getAuthHeaders(extra?: { campaignId?: string; brandId?: string; runId?: string }) {
  const headers: Record<string, string> = {
    "x-api-key": TEST_API_KEY,
    "x-org-id": TEST_ORG_ID,
    "x-user-id": TEST_USER_ID,
    "x-run-id": extra?.runId ?? TEST_RUN_ID,
  };
  if (extra?.campaignId) headers["x-campaign-id"] = extra.campaignId;
  if (extra?.brandId) headers["x-brand-id"] = extra.brandId;
  return headers;
}

/** Insert leads directly into leadBuffer for testing (replaces POST /buffer/push). */
export async function seedBuffer(params: {
  campaignId: string;
  brandId: string;
  leads: Array<{ email: string; apolloPersonId?: string; data?: unknown }>;
}): Promise<void> {
  for (const lead of params.leads) {
    await db.insert(leadBuffer).values({
      namespace: "apollo",
      campaignId: params.campaignId,
      email: lead.email,
      apolloPersonId: lead.apolloPersonId ?? null,
      data: lead.data ?? null,
      status: "buffered",
      pushRunId: null,
      brandIds: [params.brandId],
      orgId: TEST_ORG_ID,
      userId: null,
    });
  }
}
