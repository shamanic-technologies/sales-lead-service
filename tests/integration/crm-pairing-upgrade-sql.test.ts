/**
 * A frozen CRM match that was not deterministic is replaced by a deterministic one once a lead of
 * the brand carries the contact's email; a deterministic match is never touched (real database).
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { crmPairingMatches, leads } from "../../src/db/schema.js";
import { freezeMatches, loadFrozenMatches, upgradeToDeterministic } from "../../src/lib/crm-pairing-store.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("frozen CRM matches upgrade to deterministic only", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const created: string[] = [];
  afterAll(async () => {
    await db.delete(crmPairingMatches).where(eq(crmPairingMatches.brandId, brandId));
    for (const id of created) await db.delete(leads).where(eq(leads.id, id));
  });

  it("replaces an unmatched or name-guess match, never a deterministic one", async () => {
    const inserted = await db.insert(leads).values([{ name: "Lucas" }, { name: "Other" }]).returning({ id: leads.id });
    const [lead, other] = inserted.map((r) => r.id);
    created.push(lead, other);
    const none = { matchedLeadId: null, matchMethod: null, matchConfidence: "unmatched", candidateCount: 0, candidates: [] };
    const guess = { matchedLeadId: null, matchMethod: "last_name", matchConfidence: "probabilistic", candidateCount: 5, candidates: [] };
    await freezeMatches(orgId, brandId, [
      { crmContactId: "c-unmatched", result: none as never },
      { crmContactId: "c-guess", result: guess as never },
      { crmContactId: "c-email", result: { ...none, matchMethod: "email", matchConfidence: "deterministic" } as never },
    ]);
    const det = (leadId: string) =>
      ({ matchedLeadId: leadId, matchMethod: "email", matchConfidence: "deterministic", candidateCount: 1, candidates: [] }) as never;
    const n = await upgradeToDeterministic(brandId, [
      { crmContactId: "c-unmatched", result: det(lead) },
      { crmContactId: "c-guess", result: det(lead) },
      { crmContactId: "c-email", result: det(other) },
      { crmContactId: "c-unmatched", result: guess as never },
    ]);
    expect(n).toBe(2);
    const after = await loadFrozenMatches(brandId, ["c-unmatched", "c-guess", "c-email"]);
    expect(after.get("c-unmatched")).toMatchObject({ matchedLeadId: lead, matchConfidence: "deterministic", matchMethod: "email" });
    expect(after.get("c-guess")).toMatchObject({ matchedLeadId: lead, matchConfidence: "deterministic" });
    expect(after.get("c-email")).toMatchObject({ matchedLeadId: null, matchConfidence: "deterministic" });
  });
});
