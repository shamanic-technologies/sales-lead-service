/**
 * The whose-win override routes and the counts, against a REAL database: a CRM-evidenced sale
 * written the way the sync writes it, then read, overridden, withdrawn, and counted.
 */
import { beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

const { db } = await import("../../src/db/index.js");
const { leads, leadsCampaigns } = await import("../../src/db/schema.js");
const { upsertCrmOutcome } = await import("../../src/lib/crm-evidence-store.js");
const { crmCauseRule } = await import("../../src/lib/crm-evidence.js");
const crmEvidenceRoutes = (await import("../../src/routes/crm-evidence.js")).default;
const conversionsRoutes = (await import("../../src/routes/conversions.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("crm-attribution routes against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const app = express();
  app.use(express.json());
  app.use(crmEvidenceRoutes);
  app.use(conversionsRoutes);

  let rowId = "";
  let leadId = "";

  const call = (method: "get" | "put" | "delete", path: string) =>
    request(app)[method](path).set("x-api-key", "test-api-key").set("x-org-id", orgId).set("x-user-id", "u1");

  beforeAll(async () => {
    const [lead] = await db.insert(leads).values({ firstName: "Cora", lastName: "Nell" }).returning();
    leadId = lead.id;
    const [row] = await db
      .insert(leadsCampaigns)
      .values({ leadId, campaignId: `itest-${randomUUID()}`, orgId, userId: "u1", brandIds: [brandId], status: "served" })
      .returning();
    rowId = row.id;
    const rule = crmCauseRule("2026-05-14T18:02:28.528Z", "2026-05-11T00:26:36.799Z");
    await upsertCrmOutcome({
      orgId, brandId, leadId, step: "sale", occurredAt: "2026-05-14T18:02:28.528Z", valueCents: null,
      causedByOutreach: rule.causedByOutreach, email: null, matchMethod: "email",
      matchConfidence: "deterministic", candidateCount: 1,
      evidence: { crmContactId: "c1", crmStep: "sale", source: "won_status", sourceId: "o1", dateBasis: "status_changed_at", detail: null, rule },
    });
  }, 60_000);

  it("reads the rule's answer for the evidenced step and nothing for the others", async () => {
    const res = await call("get", `/orgs/leads/${rowId}/crm-attribution`);
    expect(res.status).toBe(200);
    const sale = res.body.steps.find((s: { step: string }) => s.step === "sale");
    expect(sale).toMatchObject({ causedByOutreach: true, basis: "rule", statement: null });
    expect(sale.rule.reason).toBe("after_first_delivery");
    expect(res.body.steps.find((s: { step: string }) => s.step === "meeting_booked")).toMatchObject({
      evidence: null,
      basis: null,
    });
  });

  it("a person flips it, and it reads back as their statement everywhere", async () => {
    const put = await call("put", `/orgs/leads/${rowId}/crm-attribution/sale`).send({ causedByOutreach: false });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ causedByOutreach: false, basis: "person" });

    const counts = await request(app)
      .get(`/internal/brands/${brandId}/conversion-counts`)
      .set("x-api-key", "test-api-key");
    expect(counts.status).toBe(200);
    expect(counts.body.bySource.crm.sale).toBe(1);
    expect(counts.body.counts.sale).toBe(1);
    expect(counts.body.byCause.other.sale).toBe(1);

    const converted = await request(app)
      .get(`/internal/brands/${brandId}/converted-leads?event=sale`)
      .set("x-api-key", "test-api-key");
    expect(converted.body.outcomes[0]).toMatchObject({ leadId, source: "crm", causedByOutreach: false });
  });

  it("withdrawing restores the rule's answer; withdrawing again is idempotent", async () => {
    const del = await call("delete", `/orgs/leads/${rowId}/crm-attribution/sale`);
    expect(del.body).toMatchObject({ withdrawn: true, causedByOutreach: true, basis: "rule" });
    const again = await call("delete", `/orgs/leads/${rowId}/crm-attribution/sale`);
    expect(again.body).toMatchObject({ withdrawn: false, alreadyWithdrawn: true, causedByOutreach: true });
  });

  it("refuses an override where the CRM evidences nothing, and an unknown step", async () => {
    const none = await call("put", `/orgs/leads/${rowId}/crm-attribution/meeting_booked`).send({ causedByOutreach: true });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe("no_crm_evidence");
    const bad = await call("put", `/orgs/leads/${rowId}/crm-attribution/signup`).send({ causedByOutreach: true });
    expect(bad.status).toBe(400);
  });

  it("another org's row is a 404", async () => {
    const res = await request(app)
      .get(`/orgs/leads/${rowId}/crm-attribution`)
      .set("x-api-key", "test-api-key")
      .set("x-org-id", randomUUID());
    expect(res.status).toBe(404);
  });
});
