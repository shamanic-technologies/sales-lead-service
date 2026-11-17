/**
 * UNMATCHED-MEETINGS-1117 against a REAL database: a conversion the site tag reported for a person we never served is
 * filed as a lead of the brand (by the address the event names) and attributed to them; a held name-only match keeps its
 * candidate on record; withdrawn and address-less rows are left alone; a second pass changes nothing.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { conversionEvents, leads, leadsCampaigns, leadContactMethods } from "../../src/db/schema.js";
import { conversionIntakeCampaignId, runConversionIntake } from "../../src/lib/conversion-intake.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("conversion intake: every stated conversion gets its person", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const addr = (name: string) => `${name}-${tag}@example.com`;
  const createdLeads: string[] = [];

  async function conversion(over: Partial<typeof conversionEvents.$inferInsert>): Promise<string> {
    const [row] = await db
      .insert(conversionEvents)
      .values({
        orgId,
        brandId,
        event: "meeting_booked",
        matchConfidence: "unmatched",
        attributionStatus: "unmatched",
        source: "tracker",
        receivedAt: new Date("2026-10-06T02:41:47.844Z"),
        ...over,
      })
      .returning({ id: conversionEvents.id });
    return row.id;
  }

  async function row(id: string) {
    const rows = (await db.execute(sql`
      SELECT matched_lead_id::text AS lead, attribution_status, match_method, match_confidence,
        review_candidate_lead_id::text AS candidate, attributed_by_intake_at IS NOT NULL AS by_intake
      FROM conversion_events WHERE id = ${id}::uuid
    `)) as unknown as Array<Record<string, unknown>>;
    return rows[0];
  }

  afterAll(async () => {
    await db.delete(conversionEvents).where(eq(conversionEvents.orgId, orgId));
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.orgId, orgId));
    if (createdLeads.length) {
      await db.delete(leadContactMethods).where(inArray(leadContactMethods.leadId, createdLeads));
      await db.delete(leads).where(inArray(leads.id, createdLeads));
    }
  });

  it("files the booker, attributes every live row naming them, keeps a held row's candidate, once", async () => {
    // Two bookings by one person (address case differs), one never contacted by us.
    const a1 = await conversion({ email: addr("Ana").toUpperCase(), firstName: "Ana", lastName: "Silva" });
    const a2 = await conversion({ email: addr("ana"), receivedAt: new Date("2026-10-09T06:25:23.250Z") });

    // A row held on a shared surname: its own address names another person.
    const [candidate] = await db.insert(leads).values({ name: "Other Silva", lastName: "Silva" }).returning({ id: leads.id });
    createdLeads.push(candidate.id);
    const held = await conversion({
      email: addr("bea"),
      firstName: "Bea",
      lastName: "Silva",
      matchedLeadId: candidate.id,
      matchMethod: "last_name",
      matchConfidence: "probabilistic",
      attributionStatus: "needs_review",
      candidateCount: 1,
    });

    // A person who already is a lead (another org): reused, email-first.
    const [known] = await db.insert(leads).values({ name: "Known" }).returning({ id: leads.id });
    createdLeads.push(known.id);
    await db.insert(leadContactMethods).values({ leadId: known.id, channel: "email", value: addr("known"), source: "itest" });
    const k = await conversion({ email: addr("known"), event: "sale" });

    // Left alone: withdrawn, and no address.
    const gone = await conversion({ email: addr("gone"), withdrawnAt: new Date() });
    const anon = await conversion({ email: null });

    const first = await runConversionIntake({ orgId, brandId });
    expect(first).toMatchObject({ pending: 3, filed: 3, attributedRows: 4, ambiguous: 0, teamMembers: 0 });

    const ra1 = await row(a1);
    const ra2 = await row(a2);
    expect(ra1).toMatchObject({ attribution_status: "attributed", match_method: "email", match_confidence: "deterministic", by_intake: true, candidate: null });
    expect(ra2.lead).toBe(ra1.lead);
    createdLeads.push(ra1.lead as string);

    const rheld = await row(held);
    expect(rheld).toMatchObject({ attribution_status: "attributed", candidate: candidate.id });
    expect(rheld.lead).not.toBe(candidate.id);
    createdLeads.push(rheld.lead as string);

    expect((await row(k)).lead).toBe(known.id);
    expect(await row(gone)).toMatchObject({ attribution_status: "unmatched", lead: null });
    expect(await row(anon)).toMatchObject({ attribution_status: "unmatched", lead: null });

    // Each person is ONE served row of the brand's own intake, dated at their first conversion.
    const intake = await db.select().from(leadsCampaigns).where(eq(leadsCampaigns.campaignId, conversionIntakeCampaignId(brandId)));
    expect(intake.map((r) => r.leadId).sort()).toEqual([ra1.lead, rheld.lead, known.id].sort());
    expect(intake.every((r) => r.status === "served" && r.statusReason === "tracker_conversion" && (r.brandIds ?? []).includes(brandId))).toBe(true);
    expect(intake.find((r) => r.leadId === ra1.lead)?.servedAt?.toISOString()).toBe("2026-10-06T02:41:47.844Z");

    const again = await runConversionIntake({ orgId, brandId });
    expect(again).toMatchObject({ pending: 0, filed: 0, attributedRows: 0 });
  });
});
