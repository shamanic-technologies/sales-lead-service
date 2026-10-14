/**
 * Reading who people are to a brand (RELATIONSHIP-TAGS-1014): the `relationship` block served on every
 * Unibox row (crm-service asks by human), on lead rows, and the review page's three lists.
 *
 * The block of a human at a brand is decided by `decideTags` from the three bases stored for that LEAD
 * (the human at its current company, `relationship_subjects.company_key`), with `personal` read at the
 * org x human level: a person's word on it (brand ''), else the strongest judgment over the org's brands.
 * A human the sweep never saw at this brand answers with nothing judged (`judgedAt: null`), never a guess.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { getCompanies } from "./company-client.js";
import { canonicalHumans } from "./relationship-subjects.js";
import {
  BUSINESS_ONLY_EXCLUDED,
  decideTags,
  isRelationshipTag,
  levelOf,
  policyAllows,
  tagsIn,
  type RelationshipTag,
  type TagDetail,
} from "./relationship-tags.js";
import type { CompanySource } from "./relationship-company.js";

export interface RelationshipCompany {
  id: string | null;
  name: string | null;
  domain: string | null;
  source: CompanySource;
}

export interface RelationshipBlock {
  humanId: string | null;
  company: RelationshipCompany | null;
  tags: RelationshipTag[];
  unsureTags: RelationshipTag[];
  judgedAt: string | null;
  details: TagDetail[];
  /** May a pipe stating each policy hand this person out? The one answer every server of people reads. */
  policies: { business_only: boolean };
  /** Every merge stated from here that made this person (judge or person): undo one with its `linkId`. */
  merges: SettledMerge[];
}

export interface SettledMerge {
  linkId: string;
  humanIds: string[];
  names: Array<string | null>;
  judgedBy: string;
  confidence: number;
  at: string;
}

export const EMPTY_RELATIONSHIP: RelationshipBlock = {
  humanId: null,
  company: null,
  tags: [],
  unsureTags: [],
  judgedAt: null,
  details: [],
  policies: { business_only: false },
  merges: [],
};

type Ts = Date | string;
const iso = (v: Ts | null | undefined): string | null => (v === null || v === undefined ? null : toIsoTimestamp(v));

/** The block for each requested human id (keyed on the id ASKED, merged-away ids answer for their human). */
export async function loadRelationships(orgId: string, brandId: string, humanIds: readonly string[]): Promise<Map<string, RelationshipBlock>> {
  const asked = Array.from(new Set(humanIds.filter((h) => /^[0-9a-f-]{36}$/i.test(h))));
  const out = new Map<string, RelationshipBlock>();
  if (asked.length === 0) return out;
  const canon = await canonicalHumans(orgId, asked);
  const humans = Array.from(new Set(asked.map((h) => canon.get(h) ?? h)));

  const [subjects, statements, evidence, judgments, personal, companies] = await Promise.all([
    db.execute(sql`
      SELECT human_id::text AS human, company_key FROM relationship_subjects
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND human_id = ANY(${sql.param(humans)}::uuid[])
    `) as unknown as Promise<Array<{ human: string; company_key: string }>>,
    db.execute(sql`
      SELECT human_id::text AS human, brand_id, company_key, tag, state, stated_at FROM relationship_statements
      WHERE org_id = ${orgId} AND brand_id IN (${brandId}, '') AND human_id = ANY(${sql.param(humans)}::uuid[]) AND withdrawn_at IS NULL
    `) as unknown as Promise<Array<{ human: string; brand_id: string; company_key: string; tag: string; state: "yes" | "no"; stated_at: Ts }>>,
    db.execute(sql`
      SELECT human_id::text AS human, company_key, tag, evidence, at FROM relationship_evidence
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND human_id = ANY(${sql.param(humans)}::uuid[])
    `) as unknown as Promise<Array<{ human: string; company_key: string; tag: string; evidence: string; at: Ts }>>,
    db.execute(sql`
      SELECT human_id::text AS human, company_key, probabilities, judged_at FROM relationship_judgments
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND human_id = ANY(${sql.param(humans)}::uuid[])
    `) as unknown as Promise<Array<{ human: string; company_key: string; probabilities: Record<string, number>; judged_at: Ts }>>,
    db.execute(sql`
      SELECT human_id::text AS human, max((probabilities->>'personal')::float8) AS p, max(judged_at) AS at FROM relationship_judgments
      WHERE org_id = ${orgId} AND human_id = ANY(${sql.param(humans)}::uuid[])
      GROUP BY human_id
    `) as unknown as Promise<Array<{ human: string; p: number | null; at: Ts }>>,
    db.execute(sql`
      SELECT human_id::text AS human, company_id, name, domain, source FROM relationship_companies
      WHERE org_id = ${orgId} AND human_id = ANY(${sql.param(humans)}::uuid[]) AND (company_id IS NOT NULL OR (name IS NOT NULL AND NOT conflict))
    `) as unknown as Promise<Array<{ human: string; company_id: string | null; name: string | null; domain: string | null; source: CompanySource }>>,
  ]);

  // A person with an unanswered "same person?" question may be someone we already know: held back from business-only.
  const openMerges = new Set(
    ((await db.execute(sql`
      SELECT human_a::text AS a, human_b::text AS b FROM relationship_merge_questions
      WHERE org_id = ${orgId} AND state = 'open' AND (human_a = ANY(${sql.param(humans)}::uuid[]) OR human_b = ANY(${sql.param(humans)}::uuid[]))
    `)) as unknown as Array<{ a: string; b: string }>).flatMap((r) => [r.a, r.b]),
  );
  // Merges that made each human: links stated from here whose two atomic people now name it.
  const linkedRows = (await db.execute(sql`
    SELECT q.human_a::text AS a, q.human_b::text AS b, q.link_id, q.probability, q.answered_by, q.answered_at
    FROM relationship_merge_questions q
    WHERE q.org_id = ${orgId} AND q.state = 'linked' AND q.link_id IS NOT NULL
      AND (q.human_a = ANY(${sql.param(humans)}::uuid[]) OR q.human_b = ANY(${sql.param(humans)}::uuid[])
        OR EXISTS (SELECT 1 FROM org_human_aliases o WHERE o.org_id = q.org_id AND o.human_id = ANY(${sql.param(humans)}::uuid[])
          AND o.atomic_human_id IN (q.human_a, q.human_b)))
    ORDER BY q.answered_at DESC NULLS LAST
  `)) as unknown as Array<{ a: string; b: string; link_id: string; probability: number; answered_by: string | null; answered_at: Ts | null }>;
  const linkedCanon = await canonicalHumans(orgId, linkedRows.flatMap((r) => [r.a, r.b]));
  const linkedNames = await cardsOf(orgId, brandId, Array.from(new Set(linkedRows.flatMap((r) => [r.a, r.b]))));
  const mergesOf = new Map<string, SettledMerge[]>();
  for (const r of linkedRows) {
    const merge: SettledMerge = {
      linkId: r.link_id,
      humanIds: [r.a, r.b],
      names: [linkedNames.get(r.a)?.name ?? null, linkedNames.get(r.b)?.name ?? null],
      judgedBy: r.answered_by ?? "jev",
      confidence: Number(r.probability),
      at: iso(r.answered_at) ?? "",
    };
    for (const h of new Set([linkedCanon.get(r.a) ?? r.a, linkedCanon.get(r.b) ?? r.b])) mergesOf.set(h, [...(mergesOf.get(h) ?? []), merge]);
  }
  const companyKeyOf = new Map(subjects.map((s) => [s.human, s.company_key]));
  const learned = new Map(companies.map((c) => [c.human, c]));
  // A lead's own employer key (not learned here): name it from brand-service or the local organization row.
  const leadKeys = Array.from(new Set(subjects.map((s) => s.company_key).filter((k) => k && ![...learned.values()].some((c) => c.company_id === k))));
  const keyNames = new Map<string, { name: string | null; domain: string | null }>();
  if (leadKeys.length > 0) {
    const orgRows = (await db.execute(sql`
      SELECT id::text AS id, name, primary_domain AS domain FROM organizations WHERE id = ANY(${sql.param(leadKeys)}::uuid[])
    `)) as unknown as Array<{ id: string; name: string | null; domain: string | null }>;
    for (const r of orgRows) keyNames.set(r.id, { name: r.name, domain: r.domain });
    const brandKeys = leadKeys.filter((k) => !keyNames.has(k));
    if (brandKeys.length > 0) for (const c of await getCompanies(brandKeys)) keyNames.set(c.brandId, { name: c.name, domain: c.domain });
  }

  for (const h of humans) {
    const key = companyKeyOf.get(h);
    const statementsOf = new Map<RelationshipTag, { state: "yes" | "no"; at: string }>();
    for (const s of statements) {
      if (s.human !== h || !isRelationshipTag(s.tag)) continue;
      const humanLevel = levelOf(s.tag) === "human";
      if (humanLevel ? s.brand_id !== "" : s.brand_id !== brandId || s.company_key !== (key ?? "")) continue;
      statementsOf.set(s.tag, { state: s.state, at: iso(s.stated_at)! });
    }
    const evidenceOf = new Map<RelationshipTag, { evidence: string; at: string }>();
    for (const e of evidence) if (e.human === h && e.company_key === (key ?? "") && isRelationshipTag(e.tag)) evidenceOf.set(e.tag, { evidence: e.evidence, at: iso(e.at)! });
    const j = judgments.find((x) => x.human === h && x.company_key === (key ?? ""));
    const p = personal.find((x) => x.human === h);
    let judgment: { probabilities: Partial<Record<RelationshipTag, number>>; at: string } | null = null;
    if (j || (p && p.p !== null)) {
      const probabilities: Partial<Record<RelationshipTag, number>> = {};
      for (const [k, v] of Object.entries(j?.probabilities ?? {})) if (isRelationshipTag(k) && typeof v === "number") probabilities[k] = v;
      if (p && p.p !== null) probabilities.personal = Number(p.p);
      judgment = { probabilities, at: iso(j?.judged_at ?? p!.at)! };
    }
    const details = decideTags({ statements: statementsOf, evidence: evidenceOf, judgment });
    const c = learned.get(h);
    let company: RelationshipCompany | null = null;
    if (c) company = { id: c.company_id, name: c.name, domain: c.domain, source: c.source };
    else if (key) company = { id: key, name: keyNames.get(key)?.name ?? null, domain: keyNames.get(key)?.domain ?? null, source: "lead" };
    const tags = tagsIn(details, "yes");
    const unsureTags = tagsIn(details, "unsure");
    const judgedAt = j ? iso(j.judged_at) : null;
    const block: RelationshipBlock = {
      humanId: h,
      company,
      tags,
      unsureTags,
      judgedAt,
      details,
      policies: { business_only: policyAllows("business_only", { tags, unsureTags, judgedAt, openMerge: openMerges.has(h) }) },
      merges: mergesOf.get(h) ?? [],
    };
    for (const a of asked) if ((canon.get(a) ?? a) === h) out.set(a, block);
  }
  return out;
}

export interface MergeCard {
  humanId: string;
  name: string | null;
  emails: string[];
  phones: string[];
  channels: string[];
}

export interface RelationshipReview {
  brandId: string;
  mergeQuestions: Array<{ id: string; confidence: number; reason: string | null; a: MergeCard; b: MergeCard }>;
  tagQuestions: Array<{ humanId: string; name: string | null; tag: RelationshipTag; confidence: number | null; reason: string | null }>;
  companyQuestions: Array<{ humanId: string; name: string | null; candidates: Array<{ name: string | null; domain: string | null; source: string }> }>;
  settled: {
    merges: SettledMerge[];
    people: Array<{ humanId: string; name: string | null; company: RelationshipCompany | null; tags: RelationshipTag[]; details: TagDetail[] }>;
  };
  counts: { subjects: number; judged: number; byTag: Record<string, number>; unsureMerges: number; unsureTags: number; companyQuestions: number };
}

async function cardsOf(orgId: string, brandId: string, ids: string[]): Promise<Map<string, MergeCard>> {
  if (ids.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT human_id::text AS human, name, emails, phones, channels FROM relationship_subjects
    WHERE org_id = ${orgId} AND human_id = ANY(${sql.param(ids)}::uuid[])
    ORDER BY (brand_id = ${brandId}) DESC
  `)) as unknown as Array<{ human: string; name: string | null; emails: string[]; phones: string[]; channels: string[] }>;
  const out = new Map<string, MergeCard>();
  for (const r of rows) if (!out.has(r.human)) out.set(r.human, { humanId: r.human, name: r.name, emails: r.emails, phones: r.phones, channels: r.channels });
  // A person merged into another has no lead row of their own any more: name them from their own CRM facts.
  const absorbed = ids.filter((id) => !out.has(id));
  if (absorbed.length > 0) {
    const facts = (await db.execute(sql`
      SELECT DISTINCT ON (p.atomic_human_id) p.atomic_human_id::text AS human, f.full_name AS name
      FROM relationship_person_humans p
      JOIN crm_facts f ON f.org_id = p.org_id AND f.brand_id = p.brand_id AND f.person_key = p.person_key
      WHERE p.org_id = ${orgId} AND p.atomic_human_id = ANY(${sql.param(absorbed)}::uuid[]) AND f.full_name IS NOT NULL AND f.full_name <> ''
      ORDER BY p.atomic_human_id, (p.brand_id = ${brandId}) DESC, f.seq DESC
    `)) as unknown as Array<{ human: string; name: string }>;
    for (const f of facts) out.set(f.human, { humanId: f.human, name: f.name, emails: [], phones: [], channels: [] });
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { humanId: id, name: null, emails: [], phones: [], channels: [] });
  return out;
}

export async function readReview(orgId: string, brandId: string): Promise<RelationshipReview> {
  // Only leads something speaks about can carry a tag or a question (a group roster lurker nobody judged has an empty
  // block): read those, count the rest.
  const subjects = (await db.execute(sql`
    SELECT s.human_id::text AS human, s.name FROM relationship_subjects s
    WHERE s.org_id = ${orgId} AND s.brand_id = ${brandId}
      AND (EXISTS (SELECT 1 FROM relationship_judgments j WHERE j.org_id = s.org_id AND j.human_id = s.human_id)
        OR EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.org_id = s.org_id AND e.brand_id = s.brand_id AND e.human_id = s.human_id)
        OR EXISTS (SELECT 1 FROM relationship_statements t WHERE t.org_id = s.org_id AND t.human_id = s.human_id AND t.withdrawn_at IS NULL))
    ORDER BY s.has_messages DESC, s.thread_seq DESC
  `)) as unknown as Array<{ human: string; name: string | null }>;
  const total = (await db.execute(sql`
    SELECT count(*)::int AS n FROM relationship_subjects WHERE org_id = ${orgId} AND brand_id = ${brandId}
  `)) as unknown as Array<{ n: number }>;
  const blocks = new Map<string, RelationshipBlock>();
  for (let i = 0; i < subjects.length; i += 1000) {
    const part = await loadRelationships(orgId, brandId, subjects.slice(i, i + 1000).map((s) => s.human));
    for (const [k, v] of part) blocks.set(k, v);
  }
  const nameOf = new Map(subjects.map((s) => [s.human, s.name]));

  const questions = (await db.execute(sql`
    SELECT id::text, human_a::text AS a, human_b::text AS b, probability, reason, state, link_id, answered_by, answered_at
    FROM relationship_merge_questions WHERE org_id = ${orgId} AND brand_id = ${brandId} AND state IN ('open', 'linked')
    ORDER BY probability DESC
  `)) as unknown as Array<{ id: string; a: string; b: string; probability: number; reason: string | null; state: string; link_id: string | null; answered_by: string | null; answered_at: Ts | null }>;
  const cards = await cardsOf(orgId, brandId, Array.from(new Set(questions.flatMap((q) => [q.a, q.b]))));

  const companyRows = (await db.execute(sql`
    SELECT c.human_id::text AS human, c.candidates FROM relationship_companies c
    JOIN relationship_subjects s ON s.org_id = c.org_id AND s.human_id = c.human_id AND s.brand_id = ${brandId}
    WHERE c.org_id = ${orgId} AND (c.conflict OR (c.company_id IS NULL AND c.name IS NULL AND jsonb_array_length(c.candidates) > 1))
      AND c.stated_by_user_id IS NULL
  `)) as unknown as Array<{ human: string; candidates: Array<{ name: string | null; domain: string | null; source: string }> }>;

  const tagQuestions: RelationshipReview["tagQuestions"] = [];
  const people: RelationshipReview["settled"]["people"] = [];
  const byTag: Record<string, number> = {};
  let judged = 0;
  for (const s of subjects) {
    const b = blocks.get(s.human);
    if (!b) continue;
    if (b.judgedAt) judged++;
    for (const d of b.details) if (d.state === "unsure") tagQuestions.push({ humanId: s.human, name: s.name, tag: d.tag, confidence: d.confidence, reason: null });
    for (const t of b.tags) byTag[t] = (byTag[t] ?? 0) + 1;
    if (b.tags.length > 0 || b.details.some((d) => d.basis === "person")) people.push({ humanId: s.human, name: s.name, company: b.company, tags: b.tags, details: b.details });
  }
  // The questions that decide who a business-only pipe may write to come first (a "maybe a friend" matters more
  // than a "maybe a prospect"), then the closest calls.
  const weight = (t: RelationshipTag) => (BUSINESS_ONLY_EXCLUDED.includes(t) ? 0 : t === "customer" ? 1 : 2);
  tagQuestions.sort((x, y) => weight(x.tag) - weight(y.tag) || Math.abs((x.confidence ?? 0.5) - 0.5) - Math.abs((y.confidence ?? 0.5) - 0.5));
  const open = questions.filter((q) => q.state === "open");
  return {
    brandId,
    mergeQuestions: open.map((q) => ({ id: q.id, confidence: q.probability, reason: q.reason, a: cards.get(q.a)!, b: cards.get(q.b)! })),
    tagQuestions,
    companyQuestions: companyRows.map((c) => ({ humanId: c.human, name: nameOf.get(c.human) ?? null, candidates: c.candidates })),
    settled: {
      merges: questions
        .filter((q) => q.state === "linked" && q.link_id)
        .map((q) => ({ linkId: q.link_id!, humanIds: [q.a, q.b], names: [cards.get(q.a)?.name ?? null, cards.get(q.b)?.name ?? null], judgedBy: q.answered_by ?? "jev", confidence: Number(q.probability), at: iso(q.answered_at) ?? "" })),
      people,
    },
    counts: { subjects: Number(total[0]?.n ?? 0), judged, byTag, unsureMerges: open.length, unsureTags: tagQuestions.length, companyQuestions: companyRows.length },
  };
}

export class TagStatementError extends Error {}

/** A person of the org says yes or no about one tag of one human (personal: org-wide; others: this brand's lead). */
export async function stateTag(input: { orgId: string; brandId: string; humanId: string; tag: RelationshipTag; state: "yes" | "no"; userId: string }): Promise<void> {
  const human = (await canonicalHumans(input.orgId, [input.humanId])).get(input.humanId) ?? input.humanId;
  const humanLevel = levelOf(input.tag) === "human";
  const brand = humanLevel ? "" : input.brandId;
  const companyKey = humanLevel ? "" : await subjectCompanyKey(input.orgId, input.brandId, human);
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE relationship_statements SET withdrawn_at = now(), withdrawn_by_user_id = ${input.userId}
      WHERE org_id = ${input.orgId} AND brand_id = ${brand} AND human_id = ${human}::uuid AND company_key = ${companyKey}
        AND tag = ${input.tag} AND withdrawn_at IS NULL
    `);
    await tx.execute(sql`
      INSERT INTO relationship_statements (org_id, brand_id, human_id, company_key, tag, state, stated_by_user_id)
      VALUES (${input.orgId}, ${brand}, ${human}::uuid, ${companyKey}, ${input.tag}, ${input.state}, ${input.userId})
    `);
  });
  for (const b of humanLevel ? await brandsOfHuman(input.orgId, human) : [input.brandId]) await recomputePolicy(input.orgId, b, [human]);
}

/** Withdraw a person's word on a tag (back to evidence / judgment). Returns whether one was live. */
export async function withdrawTag(input: { orgId: string; brandId: string; humanId: string; tag: RelationshipTag; userId: string }): Promise<boolean> {
  const human = (await canonicalHumans(input.orgId, [input.humanId])).get(input.humanId) ?? input.humanId;
  const humanLevel = levelOf(input.tag) === "human";
  const rows = (await db.execute(sql`
    UPDATE relationship_statements SET withdrawn_at = now(), withdrawn_by_user_id = ${input.userId}
    WHERE org_id = ${input.orgId} AND brand_id = ${humanLevel ? "" : input.brandId} AND human_id = ${human}::uuid
      AND tag = ${input.tag} AND withdrawn_at IS NULL
    RETURNING 1
  `)) as unknown as unknown[];
  for (const b of humanLevel ? await brandsOfHuman(input.orgId, human) : [input.brandId]) await recomputePolicy(input.orgId, b, [human]);
  return rows.length > 0;
}

async function subjectCompanyKey(orgId: string, brandId: string, humanId: string): Promise<string> {
  const rows = (await db.execute(sql`
    SELECT company_key FROM relationship_subjects WHERE org_id = ${orgId} AND brand_id = ${brandId} AND human_id = ${humanId}::uuid
  `)) as unknown as Array<{ company_key: string }>;
  return rows[0]?.company_key ?? "";
}

/**
 * Store each lead's policy answer where the serve pools read it (`relationship_subjects.business_only_ok`).
 * `humanIds` absent = every lead of the brand. A `personal` statement moves every brand of the human: call it
 * per brand the human is a subject of (`brandsOfHuman`).
 */
export async function recomputePolicy(orgId: string, brandId: string, humanIds?: readonly string[]): Promise<number> {
  const ids =
    humanIds ??
    ((await db.execute(sql`SELECT human_id::text AS h FROM relationship_subjects WHERE org_id = ${orgId} AND brand_id = ${brandId}`)) as unknown as Array<{ h: string }>).map(
      (r) => r.h,
    );
  let changed = 0;
  for (let i = 0; i < ids.length; i += 1000) {
    const blocks = await loadRelationships(orgId, brandId, ids.slice(i, i + 1000));
    const pairs = [...blocks.values()].filter((b) => b.humanId).map((b) => ({ h: b.humanId!, ok: b.policies.business_only }));
    if (pairs.length === 0) continue;
    const rows = (await db.execute(sql`
      UPDATE relationship_subjects s SET business_only_ok = v.ok
      FROM jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) AS v(h uuid, ok boolean)
      WHERE s.org_id = ${orgId} AND s.brand_id = ${brandId} AND s.human_id = v.h AND s.business_only_ok IS DISTINCT FROM v.ok
      RETURNING 1
    `)) as unknown as unknown[];
    changed += rows.length;
  }
  return changed;
}

export async function brandsOfHuman(orgId: string, humanId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT brand_id FROM relationship_subjects WHERE org_id = ${orgId} AND human_id = ${humanId}::uuid
  `)) as unknown as Array<{ brand_id: string }>;
  return rows.map((r) => r.brand_id);
}

/** The block of a lead row's human at a brand (lead detail, the served lead): a lead with no human yet = EMPTY. */
export async function relationshipOfLead(orgId: string, brandId: string | null | undefined, leadId: string): Promise<RelationshipBlock> {
  if (!brandId) return EMPTY_RELATIONSHIP;
  const rows = (await db.execute(sql`SELECT human_id::text AS h FROM leads WHERE id = ${leadId}::uuid`)) as unknown as Array<{ h: string | null }>;
  const h = rows[0]?.h ?? null;
  if (!h) return EMPTY_RELATIONSHIP;
  return (await loadRelationships(orgId, brandId, [h])).get(h) ?? { ...EMPTY_RELATIONSHIP, humanId: h };
}
