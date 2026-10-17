/**
 * Seeds crm-service's REGISTRY facts (CRM-REGISTRY-FACTS-1017) for integration tests: who a person IS to a brand
 * (`connection_tag`) and the company they speak for (`organization_link`). PROFESSIONAL-LEADS-1017: only people
 * tagged `professional_to_brand` are relationship subjects. PERSON-RELATIONS-1017: as crm-service does, each tag also
 * states the person key's `relation` (one contact point = the person key, so a test fact whose `contact_point` is the
 * person key is on it); `organizationLink` moves the person key's professional relation to that company.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";

let seq = BigInt(Date.now()) * 1000n + 500_000_000n + BigInt(Math.floor(Math.random() * 400_000_000));

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
  await relation({ ...p, capacity: tag.startsWith("personal") ? "personal" : "professional", tags: [tag], companyId: null });
  return id;
}

/** One crm relation of a person key (its only contact point = the person key). */
export async function relation(p: {
  orgId: string;
  brandId: string;
  human: string;
  personKey: string;
  capacity: "personal" | "professional";
  tags: string[];
  companyId: string | null;
  name?: string | null;
  emails?: string[];
  phones?: string[];
  contactPoints?: string[];
}): Promise<string> {
  const id = randomUUID();
  seq += 1n;
  const relationKey = p.capacity === "personal" ? `rel:${p.human}:personal` : p.companyId ? `rel:${p.human}:org:${p.companyId}` : `rel:${p.human}:pro`;
  const payload = {
    relationKey: `${relationKey}`,
    capacity: p.capacity,
    companyId: p.companyId,
    domain: null,
    tags: p.tags.map((tag) => ({ tag, userIds: [], brandId: tag.startsWith("professional") ? p.brandId : null, basis: [] })),
    contactPoints: (p.contactPoints ?? [p.personKey]).map((c) => ({ id: c, source: c.split(":")[0], companyBasis: null })),
    emails: p.emails ?? [],
    phones: p.phones ?? [],
    keys: [],
  };
  await db.execute(sql`
    INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
    VALUES (${id}, ${seq.toString()}::bigint, ${p.orgId}, ${p.brandId}, ${p.personKey}, ${p.name ?? null}, ${sql.param(p.emails ?? [])}::text[],
      ${sql.param(p.phones ?? [])}::text[], 'relation', NULL, 'none', 'crm', ${randomUUID()}, ${JSON.stringify(payload)}::jsonb,
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
  // The person key's professional relation now speaks for that company (crm re-states it: rel:<p>:org:<company>).
  await db.execute(sql`
    UPDATE crm_registry_facts SET payload = payload || jsonb_build_object('companyId', ${p.companyId}::text,
      'relationKey', 'rel:' || ${p.human}::text || ':org:' || ${p.companyId}::text)
    WHERE org_id = ${p.orgId} AND brand_id = ${p.brandId} AND person_key = ${p.personKey} AND type = 'relation' AND payload->>'capacity' = 'professional'
  `);
  return id;
}

export async function withdrawRegistryFact(p: { orgId: string; brandId: string; factId: string }): Promise<void> {
  // A tag withdrawn = crm re-states the person key's relation without it: its relation goes too.
  const rel = (await db.execute(sql`
    SELECT r.fact_id FROM crm_registry_facts t JOIN crm_registry_facts r ON r.org_id = t.org_id AND r.brand_id = t.brand_id
      AND r.person_key = t.person_key AND r.type = 'relation'
    WHERE t.fact_id = ${p.factId} AND t.type = 'connection_tag'
  `)) as unknown as Array<{ fact_id: string }>;
  for (const r of rel) await withdrawOne(p.orgId, p.brandId, r.fact_id);
  await withdrawOne(p.orgId, p.brandId, p.factId);
}

async function withdrawOne(orgId: string, brandId: string, factId: string): Promise<void> {
  const p = { orgId, brandId, factId };
  seq += 1n;
  await db.execute(sql`
    INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, withdrawn_of, raw)
    VALUES (${randomUUID()}, ${seq.toString()}::bigint, ${p.orgId}, ${p.brandId}, 'x', '{}'::text[], '{}'::text[], 'withdrawn', 'none', 'crm', ${randomUUID()}, '{}'::jsonb, ${p.factId}, '{}'::jsonb)
  `);
}

export async function clearRegistry(orgId: string): Promise<void> {
  await db.execute(sql`DELETE FROM crm_registry_facts WHERE org_id = ${orgId}`);
}
