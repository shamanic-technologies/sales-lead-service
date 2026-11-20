/**
 * SEC-CONVERSION-TOKEN-1120 against a REAL database: the brand-keyed token row is only ever read,
 * created or rotated by the org it belongs to. A second org (even one brand-service says also
 * holds the brand) gets 409, never the first org's token, never a second token, and its rotate
 * leaves the first org's token working.
 */
import { describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

vi.mock("../../src/lib/brand-client.js", () => ({ orgOwnsBrand: async () => true }));

const { sql } = await import("../../src/db/index.js");
const conversionsRoutes = (await import("../../src/routes/conversions.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("conversion token belongs to one org (SEC-CONVERSION-TOKEN-1120)", () => {
  const ownerOrg = randomUUID();
  const otherOrg = randomUUID();
  const brandId = randomUUID();
  const app = express();
  app.use(express.json());
  app.use(conversionsRoutes);
  const call = (method: "get" | "post", path: string, orgId: string) =>
    request(app)[method](path).set("x-api-key", "test-api-key").set("x-org-id", orgId);

  it("owner mints and reads; another org is refused on read and rotate; the owner's token is untouched", async () => {
    const first = await call("get", `/orgs/brands/${brandId}/conversion-token`, ownerOrg);
    expect(first.status).toBe(200);
    const token = first.body.token as string;
    expect(token).toMatch(/^pk_conv_/);

    const again = await call("get", `/orgs/brands/${brandId}/conversion-token`, ownerOrg);
    expect(again.status).toBe(200);
    expect(again.body.token).toBe(token);

    const foreignRead = await call("get", `/orgs/brands/${brandId}/conversion-token`, otherOrg);
    expect(foreignRead.status).toBe(409);
    expect(foreignRead.body.token).toBeUndefined();

    const foreignRotate = await call("post", `/orgs/brands/${brandId}/conversion-token/rotate`, otherOrg);
    expect(foreignRotate.status).toBe(409);
    expect(foreignRotate.body.token).toBeUndefined();

    const rows = (await sql`SELECT org_id, token, rotated_at FROM brand_conversion_tokens WHERE brand_id = ${brandId}`) as unknown as Array<{
      org_id: string;
      token: string;
      rotated_at: Date | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ org_id: ownerOrg, token, rotated_at: null });

    const rotated = await call("post", `/orgs/brands/${brandId}/conversion-token/rotate`, ownerOrg);
    expect(rotated.status).toBe(200);
    expect(rotated.body.token).not.toBe(token);
  });
});
