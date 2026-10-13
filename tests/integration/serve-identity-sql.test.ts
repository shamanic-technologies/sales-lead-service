/**
 * A lead is a human at a company, on the serve path, against a REAL database: the same human served
 * at a second company with a new work address is a NEW lead (the provider id stays with the old one),
 * served again there lands on that same new lead, served at the old company stays on the old lead, and
 * the address a lead owns still decides (one email = one lead).
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { leads } from "../../src/db/schema.js";
import { registerServedEmail, upsertLeadFromPerson } from "../../src/lib/leads-registry.js";
import type { Person } from "../../src/lib/people-client.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("serve identity: a known human at a new company is a new lead", () => {
  const tag = randomUUID().slice(0, 8);
  const human = randomUUID();
  const companyA = randomUUID();
  const companyB = randomUUID();
  const providerId = `pp-${tag}`;
  const made: string[] = [];

  const person = (email: string): Person =>
    ({
      firstName: "Americo",
      lastName: "Vargas",
      name: "Americo Vargas",
      email,
      provider: "apollo",
      providerPersonId: providerId,
      organization: null,
      linkedinUrl: null,
      businessLanguages: [],
    }) as unknown as Person;

  async function serve(email: string, companyId: string): Promise<string> {
    const id = await upsertLeadFromPerson(person(email), { enriched: true, identity: { humanId: human, companyId } });
    const leadId = await registerServedEmail({ leadId: id, email, status: null, source: "apollo" });
    made.push(leadId);
    return leadId;
  }
  const row = async (id: string) =>
    ((await db.execute(sql`SELECT human_id::text, company_id::text, apollo_person_id FROM leads WHERE id = ${id}`)) as unknown as Array<{
      human_id: string;
      company_id: string;
      apollo_person_id: string | null;
    }>)[0];

  afterAll(async () => {
    if (made.length) await db.delete(leads).where(inArray(leads.id, [...new Set(made)]));
  });

  it("splits by company, keeps the provider id on the first lead, and finds each lead again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const atA = await serve(`americo-${tag}@a.example`, companyA);
    expect(await row(atA)).toEqual({ human_id: human, company_id: companyA, apollo_person_id: providerId });

    const atB = await serve(`americo-${tag}@b.example`, companyB);
    expect(atB).not.toBe(atA);
    expect(await row(atB)).toEqual({ human_id: human, company_id: companyB, apollo_person_id: null });

    // Served again at B (another new address): the human's lead at B.
    expect(await serve(`americo2-${tag}@b.example`, companyB)).toBe(atB);
    // Served again at A by provider id with a fresh address: the lead at A.
    expect(await serve(`americo3-${tag}@a.example`, companyA)).toBe(atA);
  });

  it("keeps the lead owning the address, and logs it when that lead is at another company", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const email = `personal-${tag}@gmail.example`;
    const atA = await serve(email, companyA);
    const again = await serve(email, companyB);
    expect(again).toBe(atA);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("identity.address_held_at_other_company"))).toBe(true);
  });
});
