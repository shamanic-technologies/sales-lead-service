/**
 * The index read, executed against a REAL database.
 *
 * Everything this feature answers — a tab's count, a searched page, an export — is chosen by one
 * narrow query whose predicate is BUILT rather than written: a fragment per search word, an
 * `ILIKE` pattern with the caller's own metacharacters escaped, and a `uuid[]` the hydration is
 * filtered by. A mocked `sql` returns rows without ever compiling any of that, so a predicate that
 * cannot run still ships green (this repo has shipped exactly that: `cannot cast type record to
 * text[]`, and a raw `Date` thrown at Bind). So this file RUNS the statements.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns, leadsOrganizations, organizations } =
  await import("../../src/db/schema.js");
const { countLeadListRows, streamLeadIndex, fetchOutcomesByLead } = await import(
  "../../src/lib/lead-index.js"
);

type IndexRow = Awaited<ReturnType<typeof collectIndex>>[number];

/**
 * The whole population, collected from the chunked walk — for ASSERTIONS only.
 *
 * Production never does this: holding the population is the outage this walk exists to prevent
 * (see src/lib/lead-read-model.ts). Three rows in a test is a different proposition.
 */
async function collectIndex(
  scope: Parameters<typeof streamLeadIndex>[0],
  chunkSize = 2,
) {
  const rows = [];
  for await (const chunk of streamLeadIndex(scope, chunkSize)) rows.push(...chunk);
  return rows;
}
const { fetchBasicLeadChunk } = await import("../../src/lib/basic-leads.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("the lead index against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const campaignId = `itest-index-${randomUUID()}`;
  const scope = { orgId, brandId, statuses: ["buffered", "claimed", "served"] as const };

  const seeded: Array<{ rowId: string; leadId: string; email: string }> = [];

  async function seed(person: {
    firstName: string;
    lastName: string;
    title: string;
    company: string;
    email: string;
  }): Promise<void> {
    const [lead] = await db
      .insert(leads)
      .values({
        firstName: person.firstName,
        lastName: person.lastName,
        name: `${person.firstName} ${person.lastName}`,
      })
      .returning({ id: leads.id });
    await db.insert(leadContactMethods).values({
      leadId: lead.id,
      channel: "email",
      value: person.email,
      source: "itest",
    });
    const [org] = await db
      .insert(organizations)
      .values({ name: person.company, primaryDomain: `${person.company.toLowerCase()}.test` })
      .returning({ id: organizations.id });
    await db.insert(leadsOrganizations).values({
      leadId: lead.id,
      organizationId: org.id,
      title: person.title,
      current: true,
    });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({
        leadId: lead.id,
        campaignId,
        orgId,
        brandIds: [brandId],
        status: "served",
      })
      .returning({ id: leadsCampaigns.id });
    seeded.push({ rowId: row.id, leadId: lead.id, email: person.email });
  }

  beforeAll(async () => {
    await seed({
      firstName: "Jane",
      lastName: "Roe",
      title: "Head of Growth",
      company: "Acme",
      email: "jane.roe@acme.test",
    });
    await seed({
      firstName: "John",
      lastName: "Doe",
      title: "Chief Financial Officer",
      company: "Globex",
      email: "john.doe@globex.test",
    });
    await seed({
      // A name carrying a LIKE metacharacter: searched for literally, never as a wildcard.
      firstName: "Ten",
      lastName: "Percent_Off",
      title: "Owner",
      company: "Disco",
      email: "ten@disco.test",
    });
  }, 60_000);

  afterAll(async () => {
    for (const row of seeded) {
      await db.delete(leadsCampaigns).where(eq(leadsCampaigns.id, row.rowId));
      await db.delete(leads).where(eq(leads.id, row.leadId));
    }
  });

  it("indexes the whole scoped population, and counts the same number", async () => {
    const rows = await collectIndex(scope);
    expect(rows).toHaveLength(3);
    // The walk is CHUNKED and keyset-driven: a chunk size smaller than the population must return
    // every row exactly once, in the same total order, with no gaps and no repeats.
    expect(new Set(rows.map((r: IndexRow) => r.id)).size).toBe(3);
    expect(rows.map((r: IndexRow) => r.createdAtText)).toEqual(
      [...rows].sort((a: IndexRow, b: IndexRow) => (a.createdAtText < b.createdAtText ? -1 : 1))
        .map((r: IndexRow) => r.createdAtText),
    );
    expect(rows.map((r: IndexRow) => r.email).sort()).toEqual(seeded.map((s) => s.email).sort());
    expect(await countLeadListRows(scope)).toBe(3);
    // Every row carries the position a default-ordered cursor is built from.
    expect(rows.every((r) => typeof r.createdAtText === "string" && r.createdAtText.length > 0)).toBe(true);
  });

  it("carries the text a person is searched by, one field per line", async () => {
    const rows = await collectIndex(scope);
    const jane = rows.find((r) => r.email === "jane.roe@acme.test")!;
    expect(jane.searchText.split("\n")).toEqual([
      "Jane",
      "Roe",
      "Jane Roe",
      "Head of Growth",
      "Acme",
      "jane.roe@acme.test",
    ]);
  });

  it("narrows to named people without changing who they are", async () => {
    const rows = await collectIndex({ ...scope, leadIds: [seeded[1].leadId] });
    expect(rows.map((r) => r.id)).toEqual([seeded[1].rowId]);
  });

  it("hydrates exactly the rows an index-driven page named, and nothing else", async () => {
    const wanted = [seeded[1].rowId];
    const rows = await fetchBasicLeadChunk({ ...scope, rowIds: wanted }, null, wanted.length);
    expect(rows.map((r) => r.id)).toEqual(wanted);
    expect(rows[0].email?.value).toBe("john.doe@globex.test");
  });

  it("answers no outcomes for leads that have none, without failing on the uuid array", async () => {
    const outcomes = await fetchOutcomesByLead(
      orgId,
      brandId,
      seeded.map((s) => s.leadId),
    );
    expect(outcomes.size).toBe(0);
    expect(await fetchOutcomesByLead(orgId, brandId, [])).toEqual(new Map());
  });
});
