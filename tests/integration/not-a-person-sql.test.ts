/**
 * FAKE-OUTCOMES-1022 against a REAL database: our own staff tests never count as a brand's outcomes.
 *
 *   - `staffEmailSql` answers exactly what `isStaffEmail` answers, address by address;
 *   - a lead whose every email is a staff address is marked by the sweep, leaves every lead read of the org,
 *     and its conversions are set aside (stood back up once it carries a real address);
 *   - a lead the org STATES is not a person leaves the reads, its conversions are set aside, a later one is
 *     written set aside by the trigger, and lifting the mark stands exactly those back up;
 *   - a person's withdrawal of a wrongly attributed conversion stops it counting, and can be undone.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql as drizzleSql } from "drizzle-orm";

const { db, sql } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns } = await import("../../src/db/schema.js");
const { isStaffEmail, staffEmailSql } = await import("../../src/lib/staff-identity.js");
const { syncStaffIdentityMarks, stateNotAPerson, liftNotAPerson, listNotAPerson, resolveOrgLead } = await import(
  "../../src/lib/not-a-person.js"
);
const { listBrandConversions, withdrawConversion, restoreConversion } = await import(
  "../../src/lib/conversion-withdrawal.js"
);
const { countLeadListRows, streamLeadIndex } = await import("../../src/lib/lead-index.js");
const { streamBasicLeadChunks } = await import("../../src/lib/basic-leads.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("not a real person: staff tests never count (FAKE-OUTCOMES-1022)", () => {
  const orgId = randomUUID();
  const otherOrgId = randomUUID();
  const brandId = randomUUID();
  const campaignId = `itest-napm-${randomUUID()}`;
  const scope = { orgId, brandId, statuses: ["buffered", "claimed", "served"] as const };
  const leadIds: string[] = [];

  async function seedLead(emails: string[], org = orgId): Promise<{ leadId: string; rowId: string }> {
    const [lead] = await db.insert(leads).values({ firstName: "Alex", lastName: "Test", name: "Alex Test" }).returning({ id: leads.id });
    leadIds.push(lead.id);
    for (const value of emails) {
      await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value, source: "itest" });
    }
    const [row] = await db
      .insert(leadsCampaigns)
      .values({ leadId: lead.id, campaignId, orgId: org, brandIds: [brandId], status: "served", servedAt: new Date() })
      .returning({ id: leadsCampaigns.id });
    return { leadId: lead.id, rowId: row.id };
  }

  async function seedConversion(leadId: string | null, email: string, org = orgId): Promise<string> {
    const rows = (await db.execute(drizzleSql`
      INSERT INTO conversion_events (brand_id, org_id, event, email, matched_lead_id, match_method, match_confidence,
        attribution_status, candidate_count, received_at, source)
      VALUES (${brandId}, ${org}, 'signup', ${email}, ${leadId}, 'email', 'deterministic', 'attributed', 1, now(), 'tracker')
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    return rows[0].id;
  }

  async function population(): Promise<string[]> {
    const ids: string[] = [];
    for await (const chunk of streamLeadIndex(scope, 50)) ids.push(...chunk.map((r) => r.leadId));
    return ids.sort();
  }

  async function basicPopulation(): Promise<string[]> {
    const ids: string[] = [];
    for await (const chunk of streamBasicLeadChunks(scope, 50)) ids.push(...chunk.map((r) => r.leadId));
    return ids.sort();
  }

  afterAll(async () => {
    await sql`DELETE FROM conversion_events WHERE brand_id = ${brandId}`;
    await sql`DELETE FROM not_a_person_marks WHERE org_id IN (${orgId}, ${otherOrgId})`;
    await sql`DELETE FROM leads_campaigns WHERE campaign_id IN (${campaignId}, ${campaignId + "-other"})`;
    if (leadIds.length > 0) {
      await sql`DELETE FROM lead_contact_methods WHERE lead_id = ANY(${leadIds}::uuid[])`;
      await sql`DELETE FROM leads WHERE id = ANY(${leadIds}::uuid[])`;
    }
  });

  it("staffEmailSql agrees with isStaffEmail on every address", async () => {
    const addresses = [
      "ai-reply-test-1014b@distribute.you",
      "Kevin.Lourd+stdvocab1016@gmail.com",
      "kevin.lourd@gmail.com",
      "kevin+x@pressbeat.io",
      "kevin@distribute.you.evil.com",
      "k.lourd+probe@some-sending-domain.com",
      "jane@acme.com",
      "lourd@gmail.com",
    ];
    for (const a of addresses) {
      const rows = (await db.execute(drizzleSql`SELECT ${staffEmailSql(`'${a.replace(/'/g, "''")}'`)} AS staff`)) as unknown as Array<{ staff: boolean }>;
      expect({ a, staff: rows[0].staff }).toEqual({ a, staff: isStaffEmail(a) });
    }
  });

  it("a lead whose every email is staff leaves the reads and its outcomes stop counting; a real address brings it back", async () => {
    const real = await seedLead([`jane-${randomUUID()}@acme.test`]);
    const staff = await seedLead([`ai-reply-test-${randomUUID()}@distribute.you`]);
    const mixed = await seedLead([`kevin.lourd+${randomUUID().slice(0, 8)}@gmail.com`, `bob-${randomUUID()}@acme.test`]);
    const staffSignup = await seedConversion(staff.leadId, "ai-reply-test@distribute.you");
    const realSignup = await seedConversion(real.leadId, "jane@acme.test");

    expect(await population()).toEqual([real.leadId, staff.leadId, mixed.leadId].sort());
    await syncStaffIdentityMarks();

    expect(await population()).toEqual([real.leadId, mixed.leadId].sort());
    expect(await basicPopulation()).toEqual([real.leadId, mixed.leadId].sort());
    expect(await countLeadListRows(scope)).toBe(2);
    const marks = await listNotAPerson(orgId);
    expect(marks.map((m) => [m.leadId, m.basis])).toEqual([[staff.leadId, "staff_identity"]]);

    const convs = await listBrandConversions({ orgId, brandId, event: null, leadId: null, email: null, limit: 50 });
    expect(convs.find((c) => c.id === staffSignup)).toMatchObject({ counted: false, withdrawn: { reason: "not_a_person" } });
    expect(convs.find((c) => c.id === realSignup)).toMatchObject({ counted: true, withdrawn: null });

    // A staff mark is not a person's to lift.
    const lift = await liftNotAPerson({ orgId, leadId: staff.leadId, userId: "u1" });
    expect(lift).toMatchObject({ lifted: false, stillMarkedBy: ["staff_identity"] });

    // The lead gets a real address: the sweep lifts the mark and stands its conversion back up.
    await db.insert(leadContactMethods).values({ leadId: staff.leadId, channel: "email", value: `real-${randomUUID()}@acme.test`, source: "itest" });
    await syncStaffIdentityMarks();
    expect(await population()).toContain(staff.leadId);
    const after = await listBrandConversions({ orgId, brandId, event: null, leadId: staff.leadId, email: null, limit: 50 });
    expect(after[0]).toMatchObject({ id: staffSignup, counted: true, withdrawn: null });
  });

  it("a stated mark: out of the reads, conversions set aside (later ones too), lift restores exactly those; other orgs untouched", async () => {
    const lead = await seedLead([`alex-${randomUUID()}@acme.test`]);
    const otherOrgRow = await db
      .insert(leadsCampaigns)
      .values({ leadId: lead.leadId, campaignId: `${campaignId}-other`, orgId: otherOrgId, brandIds: [brandId], status: "served", servedAt: new Date() })
      .returning({ id: leadsCampaigns.id });
    const before = await seedConversion(lead.leadId, "alex@acme.test");
    const personWithdrawn = await seedConversion(lead.leadId, "alex2@acme.test");
    await withdrawConversion({ orgId, brandId, id: personWithdrawn, userId: "u1", note: "wrong person" });
    const foreign = await seedConversion(lead.leadId, "alex@acme.test", otherOrgId);

    expect(await resolveOrgLead(orgId, lead.rowId)).toBe(lead.leadId);
    expect(await resolveOrgLead(orgId, lead.leadId)).toBe(lead.leadId);
    expect(await resolveOrgLead(randomUUID(), lead.leadId)).toBeNull();

    const marked = await stateNotAPerson({ orgId, leadId: lead.leadId, userId: "u1", note: "our AI reply test" });
    expect(marked).toEqual({ alreadyMarked: false, setAside: 1 });
    expect(await population()).not.toContain(lead.leadId);

    // Written after the mark: set aside by the trigger, whatever the writer.
    const later = await seedConversion(lead.leadId, "alex@acme.test");
    const convs = await listBrandConversions({ orgId, brandId, event: null, leadId: lead.leadId, email: null, limit: 50 });
    const byId = new Map(convs.map((c) => [c.id, c]));
    expect(byId.get(before)).toMatchObject({ counted: false, withdrawn: { reason: "not_a_person" } });
    expect(byId.get(later)).toMatchObject({ counted: false, withdrawn: { reason: "not_a_person" } });
    expect(byId.get(personWithdrawn)).toMatchObject({ counted: false, withdrawn: { reason: "wrong_attribution" } });
    // Another org's figures are not this org's to correct.
    const theirs = await listBrandConversions({ orgId: otherOrgId, brandId, event: null, leadId: null, email: null, limit: 50 });
    expect(theirs.find((c) => c.id === foreign)).toMatchObject({ counted: true });
    expect(otherOrgRow).toHaveLength(1);

    const lifted = await liftNotAPerson({ orgId, leadId: lead.leadId, userId: "u2" });
    expect(lifted).toEqual({ lifted: true, stillMarkedBy: [], restored: 2 });
    expect(await population()).toContain(lead.leadId);
    const back = new Map(
      (await listBrandConversions({ orgId, brandId, event: null, leadId: lead.leadId, email: null, limit: 50 })).map((c) => [c.id, c]),
    );
    expect(back.get(before)?.counted).toBe(true);
    expect(back.get(later)?.counted).toBe(true);
    expect(back.get(personWithdrawn)?.counted).toBe(false);
  });

  it("a person's withdrawal stops a conversion counting and can be undone; CRM rows are refused", async () => {
    const lead = await seedLead([`dana-${randomUUID()}@acme.test`]);
    const id = await seedConversion(lead.leadId, "dana@acme.test");
    const out = await withdrawConversion({ orgId, brandId, id, userId: "u1", note: "matched by surname only" });
    expect(out.kind).toBe("withdrawn");
    if (out.kind === "withdrawn") {
      expect(out.conversion).toMatchObject({ counted: false, withdrawn: { reason: "wrong_attribution", note: "matched by surname only", byUserId: "u1" } });
    }
    expect((await withdrawConversion({ orgId, brandId, id, userId: "u1", note: "again" })).kind).toBe("already_withdrawn");
    expect((await withdrawConversion({ orgId: randomUUID(), brandId, id, userId: "u1", note: "x" })).kind).toBe("not_found");
    const restored = await restoreConversion({ orgId, brandId, id });
    expect(restored).toMatchObject({ kind: "restored", conversion: { counted: true, withdrawn: null } });
    expect((await restoreConversion({ orgId, brandId, id })).kind).toBe("not_withdrawn_by_a_person");

    const crm = (await db.execute(drizzleSql`
      INSERT INTO conversion_events (brand_id, org_id, event, email, matched_lead_id, match_confidence, attribution_status, source)
      VALUES (${brandId}, ${orgId}, 'signup', 'dana@acme.test', ${lead.leadId}, 'deterministic', 'attributed', 'crm')
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    const refused = await withdrawConversion({ orgId, brandId, id: crm[0].id, userId: "u1", note: "x" });
    expect(refused).toMatchObject({ kind: "refused", code: "crm_evidence" });
  });
});
