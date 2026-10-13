/**
 * The Disqualified mark against a REAL database: set with and without a note, removed, the offer's
 * mark before the brand-wide one, the reply sync never overriding a person's word (set OR removed),
 * the brand list, and the routes end to end.
 */
import { afterAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { leads, leadsCampaigns, leadContactMethods, leadDisqualificationMarks } from "../../src/db/schema.js";
import {
  effectiveMark,
  listBrandDisqualifications,
  loadLiveMarks,
  setDisqualification,
  syncReplyDisqualifications,
  withdrawDisqualification,
} from "../../src/lib/lead-disqualification.js";
import disqualificationRoutes from "../../src/routes/disqualifications.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("the Disqualified mark against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const offerA = randomUUID();
  const offerB = randomUUID();
  const createdLeads: string[] = [];

  async function person(): Promise<{ leadId: string; rowId: string; email: string }> {
    const [lead] = await db.insert(leads).values({ name: "Americo Vargas" }).returning({ id: leads.id });
    createdLeads.push(lead.id);
    const email = `americo-${randomUUID().slice(0, 8)}@befco.example`;
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: email, source: "itest" });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({ leadId: lead.id, campaignId: randomUUID(), orgId, brandIds: [brandId], status: "served" })
      .returning({ id: leadsCampaigns.id });
    return { leadId: lead.id, rowId: row.id, email };
  }

  const markOf = async (leadId: string, offerId: string | null) =>
    effectiveMark((await loadLiveMarks({ orgId, brandIds: [brandId], leadIds: [leadId] })).get(`${leadId}|${brandId}`), offerId);

  afterAll(async () => {
    await db.delete(leadDisqualificationMarks).where(eq(leadDisqualificationMarks.orgId, orgId));
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.orgId, orgId));
    if (createdLeads.length) {
      await db.delete(leadContactMethods).where(inArray(leadContactMethods.leadId, createdLeads));
      await db.delete(leads).where(inArray(leads.id, createdLeads));
    }
  });

  it("sets a mark with a note, restates it, and removes it (kept on record)", async () => {
    const p = await person();
    const set = await setDisqualification({
      orgId, brandId, leadId: p.leadId, offerId: null, note: "Construction company, we sell to supermarkets.",
      statedByUserId: "user-1", leadCampaignId: p.rowId,
    });
    expect(set).toMatchObject({ offerId: null, note: "Construction company, we sell to supermarkets.", source: "manual", statedByUserId: "user-1" });
    expect(await markOf(p.leadId, offerA)).toMatchObject({ note: "Construction company, we sell to supermarkets." });

    // Without a note: a plain mark.
    const plain = await setDisqualification({ orgId, brandId, leadId: p.leadId, offerId: null, note: null, statedByUserId: "user-2", leadCampaignId: p.rowId });
    expect(plain).toMatchObject({ note: null, statedByUserId: "user-2" });

    expect(await withdrawDisqualification({ orgId, brandId, leadId: p.leadId, offerId: null, withdrawnByUserId: "user-2" })).toBe(1);
    expect(await markOf(p.leadId, null)).toBeNull();
    // Idempotent.
    expect(await withdrawDisqualification({ orgId, brandId, leadId: p.leadId, offerId: null, withdrawnByUserId: "user-2" })).toBe(0);
    const rows = await db.select().from(leadDisqualificationMarks).where(eq(leadDisqualificationMarks.leadId, p.leadId));
    expect(rows).toHaveLength(1);
    expect(rows[0].withdrawnAt).not.toBeNull();
  });

  it("answers an offer with its own mark first, then the brand-wide one; a brand read only sees brand-wide", async () => {
    const p = await person();
    await setDisqualification({ orgId, brandId, leadId: p.leadId, offerId: offerA, note: "Not for offer A", statedByUserId: "u", leadCampaignId: null });
    expect(await markOf(p.leadId, offerA)).toMatchObject({ offerId: offerA, note: "Not for offer A" });
    expect(await markOf(p.leadId, offerB)).toBeNull();
    expect(await markOf(p.leadId, null)).toBeNull();
    await setDisqualification({ orgId, brandId, leadId: p.leadId, offerId: null, note: "Everywhere", statedByUserId: "u", leadCampaignId: null });
    expect(await markOf(p.leadId, offerB)).toMatchObject({ offerId: null, note: "Everywhere" });
    expect(await markOf(p.leadId, offerA)).toMatchObject({ offerId: offerA });
    // Removing every mark of the person at the brand.
    expect(await withdrawDisqualification({ orgId, brandId, leadId: p.leadId, offerId: null, withdrawnByUserId: "u" })).toBe(2);
    expect(await markOf(p.leadId, offerA)).toBeNull();
  });

  it("the reply sync marks, re-reads idempotently, withdraws when the verdict changes, and never overrides a person", async () => {
    const replied = await person();
    const overridden = await person();
    const kept = await person();
    // A person disqualified `kept` by hand, and cleared `overridden` by hand, before any reply.
    await setDisqualification({ orgId, brandId, leadId: kept.leadId, offerId: offerA, note: "My own words", statedByUserId: "u", leadCampaignId: null });
    await withdrawDisqualification({ orgId, brandId, leadId: overridden.leadId, offerId: offerA, withdrawnByUserId: "u" });

    const note = "Their reply says they are not the right contact.";
    const marks = [replied, overridden, kept].map((p) => ({ leadId: p.leadId, offerId: offerA, replyRef: `r-${p.leadId}`, note }));
    expect(await syncReplyDisqualifications(orgId, brandId, marks)).toBe(1);
    expect(await markOf(replied.leadId, offerA)).toMatchObject({ source: "reply", note, statedByUserId: null });
    expect(await markOf(overridden.leadId, offerA)).toBeNull();
    expect(await markOf(kept.leadId, offerA)).toMatchObject({ source: "manual", note: "My own words" });

    // Same replies again: nothing written.
    expect(await syncReplyDisqualifications(orgId, brandId, marks)).toBe(0);
    // The verdict changed: the reply mark goes, the person's own stays.
    expect(await syncReplyDisqualifications(orgId, brandId, [])).toBe(1);
    expect(await markOf(replied.leadId, offerA)).toBeNull();
    expect(await markOf(kept.leadId, offerA)).toMatchObject({ source: "manual" });

    // A person removes a reply mark: the reply never puts it back.
    await syncReplyDisqualifications(orgId, brandId, marks.slice(0, 1));
    expect(await markOf(replied.leadId, offerA)).toMatchObject({ source: "reply" });
    expect(await withdrawDisqualification({ orgId, brandId, leadId: replied.leadId, offerId: offerA, withdrawnByUserId: "u" })).toBe(1);
    await syncReplyDisqualifications(orgId, brandId, marks.slice(0, 1));
    expect(await markOf(replied.leadId, offerA)).toBeNull();
  });

  it("lists a brand's disqualified people with their notes, one per person", async () => {
    const p = await person();
    await setDisqualification({ orgId, brandId, leadId: p.leadId, offerId: null, note: "Brand-wide", statedByUserId: "u", leadCampaignId: null });
    await setDisqualification({ orgId, brandId, leadId: p.leadId, offerId: offerB, note: "Offer B", statedByUserId: "u", leadCampaignId: null });
    const all = await listBrandDisqualifications({ orgId, brandId, offerId: null });
    const mine = all.filter((l) => l.leadId === p.leadId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: p.rowId, email: p.email, name: "Americo Vargas" });
    const forB = (await listBrandDisqualifications({ orgId, brandId, offerId: offerB })).find((l) => l.leadId === p.leadId);
    expect(forB?.disqualification).toMatchObject({ offerId: offerB, note: "Offer B" });
    const forA = (await listBrandDisqualifications({ orgId, brandId, offerId: offerA })).find((l) => l.leadId === p.leadId);
    expect(forA?.disqualification).toMatchObject({ offerId: null, note: "Brand-wide" });
  });

  describe("the routes", () => {
    const app = express();
    app.use(express.json());
    app.use(disqualificationRoutes);
    const as = (r: request.Test) => r.set("x-api-key", "test-api-key").set("x-org-id", orgId).set("x-user-id", "user-route");

    it("PUT with a note, GET the list, DELETE: the mark comes and goes; a foreign brand is 404", async () => {
      const p = await person();
      const put = await as(request(app).put(`/orgs/leads/${p.rowId}/disqualification`)).send({ note: "  Not our target  " });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({ id: p.rowId, leadId: p.leadId, brandId, offerId: null, disqualified: true });
      expect(put.body.disqualification).toMatchObject({ note: "Not our target", source: "manual", statedByUserId: "user-route" });

      const list = await as(request(app).get(`/orgs/leads/disqualifications?brandId=${brandId}`));
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(list.body.leads.length);
      expect(list.body.leads.find((l: { leadId: string }) => l.leadId === p.leadId)?.disqualification.note).toBe("Not our target");

      const noNote = await as(request(app).put(`/orgs/leads/${p.rowId}/disqualification`)).send({});
      expect(noNote.body.disqualification.note).toBeNull();

      const del = await as(request(app).delete(`/orgs/leads/${p.rowId}/disqualification`));
      expect(del.status).toBe(200);
      expect(del.body).toMatchObject({ withdrawn: 1, disqualified: false, disqualification: null });

      const foreign = await as(request(app).put(`/orgs/leads/${p.rowId}/disqualification`)).send({ brandId: randomUUID() });
      expect(foreign.status).toBe(404);
      const noUser = await request(app).put(`/orgs/leads/${p.rowId}/disqualification`).set("x-api-key", "test-api-key").set("x-org-id", orgId).send({});
      expect(noUser.status).toBe(400);
      const tooLong = await as(request(app).put(`/orgs/leads/${p.rowId}/disqualification`)).send({ note: "x".repeat(2001) });
      expect(tooLong.status).toBe(400);
    });
  });
});
