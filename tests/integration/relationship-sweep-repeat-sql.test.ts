/**
 * LEDGER-RESIDUAL-1025 against a REAL database: which crm relation keys crm-service IDENTIFIED as a lead of the brand
 * (a `relation` registry fact tagged `professional_to_brand` with a judged conversation among the tag's basis), the
 * rule the relationship sweep reads to open its `repeat_production` run. A source-earned tag (no conversation basis),
 * another brand, or another tag is not identified.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { crmIdentifiedAmong } = await import("../../src/lib/crm-lead-identified.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("crmIdentifiedAmong (LEDGER-RESIDUAL-1025)", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  let seq = BigInt(Date.now()) * 1000n + 777_000_000n;

  async function relation(brand: string, relationKey: string, tags: unknown[]): Promise<void> {
    seq += 1n;
    await db.execute(sql`
      INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${seq.toString()}::bigint, ${orgId}, ${brand}, ${`itest:${relationKey}`}, '{}', '{}', 'relation', 'none', 'crm',
        ${randomUUID()}, ${JSON.stringify({ relationKey, capacity: "professional", companyId: "", tags })}::jsonb, '{}'::jsonb)`);
  }

  afterAll(async () => {
    await db.execute(sql`DELETE FROM crm_registry_facts WHERE org_id = ${orgId}`);
  });

  it("names only relations a judged conversation tagged professional TO the brand", async () => {
    await relation(brandId, "rel:judged", [{ tag: "professional_to_brand", basis: [{ kind: "conversation" }, { kind: "source" }] }]);
    await relation(brandId, "rel:source-only", [{ tag: "professional_to_brand", basis: [{ kind: "source" }] }]);
    await relation(brandId, "rel:not-to", [{ tag: "professional_not_to_brand", basis: [{ kind: "conversation" }] }]);
    await relation(randomUUID(), "rel:other-brand", [{ tag: "professional_to_brand", basis: [{ kind: "conversation" }] }]);
    const got = await crmIdentifiedAmong(orgId, brandId, ["rel:judged", "rel:source-only", "rel:not-to", "rel:other-brand", "rel:unknown"]);
    expect([...got]).toEqual(["rel:judged"]);
    expect([...(await crmIdentifiedAmong(orgId, brandId, []))]).toEqual([]);
  });
});
