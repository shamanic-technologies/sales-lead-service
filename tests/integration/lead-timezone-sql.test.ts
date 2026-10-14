/**
 * A lead's timezone precedence against a REAL database (PUSHED-PERSON-TZ-1014): stated > enrichment >
 * inferred, each guard inside its own UPDATE; the sweep fills only empty zones and visits a lead once.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, organizations } = await import("../../src/db/schema.js");
const { writeStatedTimezone, writeEnrichedTimezone, inferLeadTimezone, inferPendingTimezones } = await import(
  "../../src/lib/lead-timezone.js"
);

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("lead timezone precedence against a real database", () => {
  const tag = randomUUID().slice(0, 8);
  const leadIds: string[] = [];
  const orgIds: string[] = [];

  async function newLead(values: Partial<typeof leads.$inferInsert> = {}): Promise<string> {
    const [row] = await db.insert(leads).values({ name: `tz-${tag}`, ...values }).returning({ id: leads.id });
    leadIds.push(row.id);
    return row.id;
  }
  async function read(id: string) {
    const [row] = await db.select().from(leads).where(eq(leads.id, id));
    return row;
  }

  afterAll(async () => {
    if (leadIds.length) {
      await db.delete(leadContactMethods).where(inArray(leadContactMethods.leadId, leadIds));
      await db.delete(leads).where(inArray(leads.id, leadIds));
    }
    if (orgIds.length) await db.delete(organizations).where(inArray(organizations.id, orgIds));
  });

  it("an inference never replaces an enriched zone; enrichment replaces an inferred one", async () => {
    const enriched = await newLead({ timezone: "America/Denver", timezoneSource: "enrichment" });
    await db.insert(leadContactMethods).values({ leadId: enriched, channel: "phone", value: `+44 7700 ${Math.floor(100000 + Math.random() * 899999)}`, source: "test" });
    await inferLeadTimezone(enriched);
    expect(await read(enriched)).toMatchObject({ timezone: "America/Denver", timezoneSource: "enrichment" });

    const inferred = await newLead({ country: "France" });
    await inferLeadTimezone(inferred);
    expect(await read(inferred)).toMatchObject({ timezone: "Europe/Paris", timezoneSource: "inferred", timezoneBasis: "lead_location" });
    await writeEnrichedTimezone(inferred, "Europe/Berlin");
    expect(await read(inferred)).toMatchObject({ timezone: "Europe/Berlin", timezoneSource: "enrichment", timezoneBasis: null });
  });

  it("enrichment never replaces a stated zone; a statement replaces anything", async () => {
    const id = await newLead({ timezone: "Asia/Tokyo", timezoneSource: "enrichment" });
    await writeStatedTimezone(id, "Europe/London");
    await writeEnrichedTimezone(id, "America/Chicago");
    await inferLeadTimezone(id);
    expect(await read(id)).toMatchObject({ timezone: "Europe/London", timezoneSource: "stated" });
  });

  it("reads the employer's location when the person has none", async () => {
    const [org] = await db.insert(organizations).values({ name: `tz-org-${tag}`, country: "United States", state: "Texas" }).returning({ id: organizations.id });
    orgIds.push(org.id);
    const id = await newLead({ country: "United States", organizationId: org.id });
    await inferLeadTimezone(id);
    expect(await read(id)).toMatchObject({ timezone: "America/Chicago", timezoneBasis: "company_location" });
  });

  it("the sweep fills empty zones, marks hopeless leads checked, and visits each once", async () => {
    const hopeful = await newLead({ country: "United Kingdom" });
    const hopeless = await newLead({ country: "United States" });
    const kept = await newLead({ timezone: "Asia/Tokyo", timezoneSource: "enrichment", country: "France" });
    for (let i = 0; i < 50; i++) {
      const r = await inferPendingTimezones(5000);
      if (r.checked === 0) break;
    }
    expect(await read(hopeful)).toMatchObject({ timezone: "Europe/London", timezoneSource: "inferred" });
    const h = await read(hopeless);
    expect(h.timezone).toBeNull();
    expect(h.timezoneCheckedAt).not.toBeNull();
    expect(await read(kept)).toMatchObject({ timezone: "Asia/Tokyo", timezoneSource: "enrichment" });
  });
});
