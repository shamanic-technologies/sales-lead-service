/**
 * Seeds crm-service's REGISTRY facts (CRM-REGISTRY-FACTS-1017) for integration tests: who a person IS to a brand
 * (`connection_tag`) and the company they speak for (`organization_link`). PROFESSIONAL-LEADS-1017: only people
 * tagged `professional_to_brand` are relationship subjects.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";

let seq = BigInt(Date.now()) * 1000n + 500_000_000n;

export async function connectionTag(p: {
  orgId: string;
  brandId: string;
  human: string;
  personKey: string;
  tag?: "professional_to_brand" | "professional_not_to_brand" | "personal_to_user" | "personal_not_to_user";
  name?: string | null;
  emails?: string[];
  phones?: string[];
}): Promise<string> {
  const id = randomUUID();
  seq += 1n;
  const tag = p.tag ?? "professional_to_brand";
  await db.execute(sql`
    INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
    VALUES (${id}, ${seq.toString()}::bigint, ${p.orgId}, ${p.brandId}, ${p.personKey}, ${p.name ?? null}, ${sql.param(p.emails ?? [])}::text[],
      ${sql.param(p.phones ?? [])}::text[], 'connection_tag', NULL, 'none', 'crm', ${randomUUID()},
      ${JSON.stringify({ tag, brandId: tag.startsWith("professional") ? p.brandId : null, userIds: [], basis: [] })}::jsonb,
      ${JSON.stringify({ humanId: p.human })}::jsonb)
  `);
  return id;
}

export async function organizationLink(p: { orgId: string; brandId: string; human: string; personKey: string; companyId: string }): Promise<string> {
  const id = randomUUID();
  seq += 1n;
  await db.execute(sql`
    INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
    VALUES (${id}, ${seq.toString()}::bigint, ${p.orgId}, ${p.brandId}, ${p.personKey}, NULL, '{}'::text[], '{}'::text[], 'organization_link', NULL, 'none', 'crm',
      ${randomUUID()}, ${JSON.stringify({ companyId: p.companyId, domain: null, tags: ["professional_to_brand"], evidence: [] })}::jsonb,
      ${JSON.stringify({ humanId: p.human })}::jsonb)
  `);
  return id;
}

export async function withdrawRegistryFact(p: { orgId: string; brandId: string; factId: string }): Promise<void> {
  seq += 1n;
  await db.execute(sql`
    INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, withdrawn_of, raw)
    VALUES (${randomUUID()}, ${seq.toString()}::bigint, ${p.orgId}, ${p.brandId}, 'x', '{}'::text[], '{}'::text[], 'withdrawn', 'none', 'crm', ${randomUUID()}, '{}'::jsonb, ${p.factId}, '{}'::jsonb)
  `);
}

export async function clearRegistry(orgId: string): Promise<void> {
  await db.execute(sql`DELETE FROM crm_registry_facts WHERE org_id = ${orgId}`);
}
