/**
 * BOX-LOAD-1028-LEAD-DAY: the indexed "does this CRM fact name this address / phone?" predicate (crm-fact-contact.ts,
 * migration 0131) selects EXACTLY the rows the old unnest form did, on tricky values (case, padding, empty arrays,
 * several addresses, phone punctuation), and the planner can answer it from the GIN index.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql as dsql } from "drizzle-orm";

const { db, sql } = await import("../../src/db/index.js");
const { crmFactHasEmail, crmFactHasPhone } = await import("../../src/lib/crm-fact-contact.js");
const { phoneValueSql } = await import("../../src/lib/e164-phone.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("crm fact contact predicate against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  let seq = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const nextSeq = () => (seq += 1n).toString();

  const facts: Array<{ id: string; emails: string[]; phones: string[] }> = [
    { id: "upper", emails: ["  Ann@Example.COM "], phones: [] },
    { id: "plain", emails: ["ann@example.com"], phones: ["+33 6 12 34 56 78"] },
    { id: "several", emails: ["bob@example.com", "ANN@example.com"], phones: ["(+33)6.12.34.56.78"] },
    { id: "empty", emails: [], phones: [] },
    { id: "other", emails: ["carl@example.com"], phones: ["+14155550100"] },
    { id: "tab", emails: ["\tann@example.com"], phones: ["+33-612-345-678"] },
  ];

  async function seed() {
    for (const f of facts) {
      await sql`
        INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
        VALUES (${`${f.id}-${tag}`}, ${nextSeq()}::bigint, ${orgId}, ${brandId}, 'pk', ${f.emails}::text[], ${f.phones}::text[], 'message_in',
                now(), 'sent_at', 'gmail', ${`ref-${f.id}-${tag}`}, '{}'::jsonb, '{}'::jsonb)
      `;
    }
  }

  async function ids(predicate: ReturnType<typeof dsql>): Promise<string[]> {
    const rows = (await db.execute(dsql`
      SELECT f.fact_id FROM crm_facts f WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId} AND ${predicate} ORDER BY f.fact_id
    `)) as unknown as Array<{ fact_id: string }>;
    return rows.map((r) => r.fact_id);
  }

  it("selects the same facts as the unnest form, for every address and phone asked", async () => {
    await seed();
    const emails = ["ann@example.com", "bob@example.com", "carl@example.com", "Ann@Example.COM", " ann@example.com", "nobody@example.com", ""];
    for (const email of emails) {
      const before = await ids(dsql`EXISTS (SELECT 1 FROM unnest(f.emails) AS e WHERE lower(trim(e)) = ${email})`);
      expect(await ids(crmFactHasEmail("f", email))).toEqual(before);
    }
    expect(await ids(crmFactHasEmail("f", "ann@example.com"))).toEqual([`plain-${tag}`, `several-${tag}`, `upper-${tag}`]);

    const phones = ["+33612345678", "+14155550100", "+33 6 12 34 56 78", "+10000000000"];
    for (const phone of phones) {
      const before = await ids(dsql`EXISTS (SELECT 1 FROM unnest(f.phones) AS p WHERE ${phoneValueSql(dsql`p`)} = ${phone})`);
      expect(await ids(crmFactHasPhone("f", phone))).toEqual(before);
    }
    expect(await ids(crmFactHasPhone("f", "+33612345678"))).toEqual([`plain-${tag}`, `several-${tag}`, `tab-${tag}`]);
  });

  it("is answerable from a GIN index on the same expression", async () => {
    // On a private temp table: an index build on crm_facts itself would lock the table against the parallel test files.
    const rolledBack = new Error("probe rolled back");
    let plan = "";
    await sql
      .begin(async (tx) => {
        await tx.unsafe("CREATE TEMP TABLE crm_fact_contact_probe (emails text[] NOT NULL) ON COMMIT DROP");
        await tx.unsafe("INSERT INTO crm_fact_contact_probe SELECT ARRAY['p' || g || '@example.com'] FROM generate_series(1, 2000) g");
        await tx.unsafe("CREATE INDEX crm_fact_contact_probe_idx ON crm_fact_contact_probe USING gin (crm_fact_emails_norm(emails))");
        await tx.unsafe("ANALYZE crm_fact_contact_probe");
        const rows = await tx.unsafe(
          "EXPLAIN SELECT 1 FROM crm_fact_contact_probe f WHERE crm_fact_emails_norm(f.emails) @> ARRAY['p7@example.com'::text]",
        );
        plan = rows.map((r) => String(Object.values(r)[0])).join("\n");
        throw rolledBack;
      })
      .catch((error: unknown) => {
        if (error !== rolledBack) throw error;
      });
    expect(plan).toContain("crm_fact_contact_probe_idx");
  });
});
