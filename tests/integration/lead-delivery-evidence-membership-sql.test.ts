/**
 * The stored delivery evidence read (lead-delivery-evidence.ts) against a REAL database: a whole
 * scope's addresses are matched with a hashed `NOT (email NOT IN (...))`, a few with `= ANY(...)`
 * (DASH-SPEED-1110-LEAD-R2). Both forms must answer exactly the stored rows asked for, never a row
 * of another scope, never a row nobody asked about. Nothing here reaches email-gateway: every
 * stored answer is recent enough, and an address with nothing stored would throw on the fake context.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { sql } = await import("../../src/db/index.js");
const { readDeliveryEvidence, HASHED_MEMBERSHIP_FROM } = await import("../../src/lib/lead-delivery-evidence.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

const ORG = "org-evidence-membership-test";
const BRAND = "brand-evidence-membership-test";
const OTHER_BRAND = "brand-evidence-membership-other";
const STORED = 2 * HASHED_MEMBERSHIP_FROM + 300;

const addressOf = (i: number) => `person${i}@membership.test`;

describe.skipIf(!hasRealDatabase)("stored delivery evidence membership", () => {
  beforeAll(async () => {
    await sql`DELETE FROM lead_delivery_evidence WHERE org_id = ${ORG}`;
    const emails = Array.from({ length: STORED }, (_, i) => addressOf(i));
    const results = emails.map((email, i) => (i % 7 === 0 ? null : JSON.stringify({ email, contacted: i % 2 === 0 })));
    const now = new Date().toISOString();
    for (const brand of [BRAND, OTHER_BRAND]) {
      await sql`
        INSERT INTO lead_delivery_evidence (org_id, brand_id, campaign_id, email, result, fetched_at)
        SELECT ${ORG}, ${brand}, '', u.email, u.result::jsonb, ${now}::timestamptz
        FROM unnest(${emails}::text[], ${results}::text[]) AS u(email, result)
      `;
    }
  });

  afterAll(async () => {
    await sql`DELETE FROM lead_delivery_evidence WHERE org_id = ${ORG}`;
  });

  async function read(indexes: number[]) {
    return readDeliveryEvidence(
      indexes.map((i) => ({ brandId: BRAND, email: addressOf(i) })),
      {
        orgId: ORG,
        campaignId: undefined,
        acceptFetchedSince: new Date(Date.now() - 60 * 60_000),
        context: { orgId: ORG } as never,
      },
    );
  }

  function expected(indexes: number[]) {
    return new Map(
      indexes.filter((i) => i % 7 !== 0).map((i) => [addressOf(i), { email: addressOf(i), contacted: i % 2 === 0 }]),
    );
  }

  it("answers a whole scope (hashed membership) with exactly the rows asked for", async () => {
    // Every other stored address: the scope holds rows nobody asked about, which must not come back.
    const asked = Array.from({ length: STORED }, (_, i) => i).filter((i) => i % 2 === 1);
    expect(asked.length).toBeGreaterThan(HASHED_MEMBERSHIP_FROM);
    expect(await read(asked)).toEqual(expected(asked));
  });

  it("answers a few addresses (ANY list) the same way", async () => {
    const asked = [1, 3, 14, 21, 500];
    expect(await read(asked)).toEqual(expected(asked));
  });
});
