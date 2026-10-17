/**
 * Reading who people are to a brand (RELATIONSHIP-TAGS-1014): the `relationship` block served on every
 * Unibox row (crm-service asks by human), on lead rows, and the review page's three lists.
 *
 * The block of a human at a brand is decided by `decideTags` from the three bases stored for that LEAD
 * (the human at its current company, `relationship_subjects.company_key`), with `personal` read at the
 * org x human level: a person's word on it (brand ''), else crm-service's `personal_*` connection tag on the human
 * at any brand of the org (PROFESSIONAL-LEADS-1017: never judged here any more). The company is the one crm-service
 * links the person to (else their lead's employer). A human the sweep never saw at this brand answers with nothing
 * judged (`judgedAt: null`), never a guess.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { getCompanies } from "./company-client.js";
import { canonicalHumans, subjectKey } from "./relationship-subjects.js";
import { canonicalHumanSql, JOURNALIST_TAG, PRESS_ONLY_EVIDENCE, refreshBrandJournalists } from "./brand-journalists.js";
import {
  BUSINESS_ONLY_EXCLUDED,
  decideTags,
  isRelationshipTag,
  levelOf,
  policyAllows,
  pureProspectAllows,
  tagsIn,
  type RelationshipTag,
  type TagDetail,
} from "./relationship-tags.js";
import type { CompanySource } from "./relationship-company.js";
import {
  decideLead,
  decideWantsBusiness,
  EMPTY_LEAD,
  EMPTY_WANTS_BUSINESS,
  WANTS_BUSINESS,
  type IntentAnswerKey,
  type LeadAnswer,
  type WantsBusinessAnswer,
} from "./relationship-intent.js";

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
  /** Is the person a relationship subject of the brand: crm-service tags them `professional_to_brand`? */
  subject: boolean;
  /** crm-service's live connection tags on the human: this brand's, and the org-wide `personal_*` ones. */
  connectionTags: string[];
  /**
   * May a pipe stating each policy hand this person out? The one answer every server of people reads.
   * `pure_prospect`: no tag but prospect (NEVER-NO-FOLLOWUP-1014, src/lib/prospect-followup.ts).
   */
  policies: { business_only: boolean; pure_prospect: boolean };
  /** Every merge stated from here that made this person (judge or person): undo one with its `linkId`. */
  merges: SettledMerge[];
  /** Did the person write to the brand (a message on any mirrored channel, a signup, a form, a meeting, a payment, a reply to our outreach)? */
  wroteToUs: boolean;
  lastInboundAt: string | null;
  /** HOT-INBOUND-UNANSWERED-1016: is the person a LEAD of the brand (relationship-intent.ts)? */
  lead: LeadAnswer;
  /** If a lead: do they WANT to do business with the brand? */
  wantsBusiness: WantsBusinessAnswer;
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
  subject: false,
  connectionTags: [],
  policies: { business_only: false, pure_prospect: false },
  merges: [],
  wroteToUs: false,
  lastInboundAt: null,
  lead: EMPTY_LEAD,
  wantsBusiness: EMPTY_WANTS_BUSINESS,
};

type Ts = Date | string;
const iso = (v: Ts | null | undefined): string | null => (v === null || v === undefined ? null : toIsoTimestamp(v));

/** Every atomic human this org folds into each of `humans` (its own links, fleet merges), the human itself excluded. */
async function atomicHumansOf(orgId: string, humans: readonly string[]): Promise<Map<string, string[]>> {
  if (humans.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT o.human_id::text AS human, o.atomic_human_id::text AS atomic FROM org_human_aliases o
    WHERE o.org_id = ${orgId} AND o.human_id = ANY(${sql.param([...humans])}::uuid[]) AND o.atomic_human_id <> o.human_id
    UNION
    SELECT ha.human_id::text, ha.atomic_human_id::text FROM human_aliases ha
    WHERE ha.human_id = ANY(${sql.param([...humans])}::uuid[]) AND ha.atomic_human_id <> ha.human_id
  `)) as unknown as Array<{ human: string; atomic: string }>;
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.human, [...(out.get(r.human) ?? []), r.atomic]);
  return out;
}

/**
 * The block for each requested human id (keyed on the id ASKED, merged-away ids answer for their human): the PERSON
 * read every server of people asks (a serve, a claim, crm-service's business-only check). A human with several
 * relations at the brand answers with the latest-active one, and its policies hold only if EVERY relation allows
 * (fail-closed: a business pipe never writes to someone one of their relations says it should not). `personal` is
 * read at the human (crm's `personal_*` tag on any point, any brand of the org).
 */
export async function loadRelationships(orgId: string, brandId: string, humanIds: readonly string[]): Promise<Map<string, RelationshipBlock>> {
  return loadBlocks(orgId, brandId, humanIds, null);
}

/**
 * The block of each RELATION (a human at a company, PERSON-RELATIONS-1017), keyed `subjectKey(human asked, company)`:
 * the Unibox row's read. Only that relation's stored answers, and `personal` / connection tags read off ITS own
 * points (crm's relation tags), never the human's other relations.
 */
export async function loadRelationshipsAt(
  orgId: string,
  brandId: string,
  keys: ReadonlyArray<{ humanId: string; companyKey: string }>,
): Promise<Map<string, RelationshipBlock>> {
  return loadBlocks(orgId, brandId, keys.map((k) => k.humanId), keys);
}

async function loadBlocks(
  orgId: string,
  brandId: string,
  humanIds: readonly string[],
  relationKeys: ReadonlyArray<{ humanId: string; companyKey: string }> | null,
): Promise<Map<string, RelationshipBlock>> {
  const asked = Array.from(new Set(humanIds.filter((h) => /^[0-9a-f-]{36}$/i.test(h))));
  const out = new Map<string, RelationshipBlock>();
  if (asked.length === 0) return out;
  const canon = await canonicalHumans(orgId, asked);
  const humans = Array.from(new Set(asked.map((h) => canon.get(h) ?? h)));

  // crm-service's connection tags name crm's human; read them for every atomic human that folds into ours.
  const atomicByCanon = await atomicHumansOf(orgId, humans);
  const atomicAll = Array.from(new Set([...humans, ...[...atomicByCanon.values()].flat()]));
  const [subjects, statements, evidence, judgments, connections, pressOnly, intents] = await Promise.all([
    db.execute(sql`
      SELECT human_id::text AS human, company_key, wrote_to_us, last_inbound_at, has_direct, relation_keys, updated_at FROM relationship_subjects
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND human_id = ANY(${sql.param(humans)}::uuid[])
      ORDER BY human_id, last_inbound_at DESC NULLS LAST, updated_at DESC, company_key
    `) as unknown as Promise<Array<{ human: string; company_key: string; wrote_to_us: boolean; last_inbound_at: Ts | null; has_direct: boolean; relation_keys: string[]; updated_at: Ts }>>,
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
      SELECT f.raw->>'humanId' AS human, f.brand_id, f.payload->>'tag' AS tag, min(f.received_at) AS at
      FROM crm_registry_facts f
      WHERE f.org_id = ${orgId} AND f.type = 'connection_tag' AND f.raw->>'humanId' = ANY(${sql.param(atomicAll)}::text[])
        AND (f.brand_id = ${brandId} OR f.payload->>'tag' LIKE 'personal%')
        AND NOT EXISTS (SELECT 1 FROM crm_registry_facts w WHERE w.withdrawn_of = f.fact_id)
      GROUP BY 1, 2, 3
    `) as unknown as Promise<Array<{ human: string; brand_id: string; tag: string; at: Ts }>>,
    // Journalist evidence (brand-journalists.ts): a lead of the human the brand reached ONLY through a press pitch.
    db.execute(sql`
      SELECT h.human::text AS human, COALESCE(min(bj.first_pitched_at), min(bj.updated_at)) AS at
      FROM brand_journalists bj
      JOIN leads l ON l.id = bj.lead_id
      CROSS JOIN LATERAL (SELECT ${canonicalHumanSql(sql`${orgId}`, "l")} AS human) h
      WHERE bj.org_id = ${orgId} AND bj.brand_id = ${brandId} AND bj.press_only AND h.human = ANY(${sql.param(humans)}::uuid[])
      GROUP BY h.human
    `) as unknown as Promise<Array<{ human: string; at: Ts }>>,
    db.execute(sql`
      SELECT human_id::text AS human, company_key, p_wants_business AS p, judged_at FROM relationship_intent_judgments
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND human_id = ANY(${sql.param(humans)}::uuid[])
    `) as unknown as Promise<Array<{ human: string; company_key: string; p: number; judged_at: Ts }>>,
  ]);

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
  type SubjectRow = (typeof subjects)[number];
  const subjectsOf = new Map<string, SubjectRow[]>();
  for (const r of subjects) subjectsOf.set(r.human, [...(subjectsOf.get(r.human) ?? []), r]);
  const canonOfAtomic = new Map<string, string>();
  for (const h of humans) {
    canonOfAtomic.set(h, h);
    for (const a of atomicByCanon.get(h) ?? []) canonOfAtomic.set(a, h);
  }
  // A relation's own tags (crm's relation fact): the connection tags of ITS points only (PERSON-RELATIONS-1017).
  const tagsOfRelation = new Map<string, string[]>();
  if (relationKeys !== null) {
    const keys = Array.from(new Set(subjects.flatMap((r) => r.relation_keys ?? [])));
    if (keys.length > 0) {
      const rel = (await db.execute(sql`
        SELECT f.payload->>'relationKey' AS key, f.payload->'tags' AS tags FROM crm_registry_facts f
        WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId} AND f.type = 'relation' AND f.payload->>'relationKey' = ANY(${sql.param(keys)}::text[])
          AND NOT EXISTS (SELECT 1 FROM crm_registry_facts w WHERE w.withdrawn_of = f.fact_id)
      `)) as unknown as Array<{ key: string; tags: Array<{ tag?: unknown }> | null }>;
      for (const r of rel) tagsOfRelation.set(r.key, (r.tags ?? []).map((t) => t?.tag).filter((t): t is string => typeof t === "string"));
    }
  }
  // A company key: a local organization row (a lead's own employer) or a brand-service id (crm-service's link).
  const leadKeys = Array.from(new Set(subjects.map((s) => s.company_key).filter((k) => k)));
  const keyNames = new Map<string, { name: string | null; domain: string | null }>();
  const localNamed = new Set<string>();
  if (leadKeys.length > 0) {
    const localKeys = leadKeys.filter((k) => /^[0-9a-f-]{36}$/i.test(k));
    const orgRows = (await db.execute(sql`
      SELECT id::text AS id, name, primary_domain AS domain FROM organizations WHERE id = ANY(${sql.param(localKeys)}::uuid[])
    `)) as unknown as Array<{ id: string; name: string | null; domain: string | null }>;
    for (const r of orgRows) {
      keyNames.set(r.id, { name: r.name, domain: r.domain });
      localNamed.add(r.id);
    }
    const brandKeys = leadKeys.filter((k) => !keyNames.has(k));
    if (brandKeys.length > 0) for (const c of await getCompanies(brandKeys)) keyNames.set(c.brandId, { name: c.name, domain: c.domain });
  }

  /** The block of human `h` at `key`; `subj` = that relation's subject row (null = not a subject there). */
  const blockOf = (h: string, key: string, subj: SubjectRow | null, relationScoped: boolean): RelationshipBlock => {
    const statementsOf = new Map<RelationshipTag, { state: "yes" | "no"; at: string }>();
    let wantsStatement: { state: "yes" | "no"; at: string } | null = null;
    for (const s of statements) {
      if (s.human === h && s.tag === WANTS_BUSINESS && s.brand_id === brandId && s.company_key === key) {
        wantsStatement = { state: s.state, at: iso(s.stated_at)! };
        continue;
      }
      if (s.human !== h || !isRelationshipTag(s.tag)) continue;
      const humanLevel = levelOf(s.tag) === "human";
      if (humanLevel ? s.brand_id !== "" : s.brand_id !== brandId || s.company_key !== key) continue;
      statementsOf.set(s.tag, { state: s.state, at: iso(s.stated_at)! });
    }
    const evidenceOf = new Map<RelationshipTag, { evidence: string; at: string }>();
    for (const e of evidence) if (e.human === h && e.company_key === key && isRelationshipTag(e.tag)) evidenceOf.set(e.tag, { evidence: e.evidence, at: iso(e.at)! });
    const pitched = pressOnly.find((x) => x.human === h);
    if (pitched) evidenceOf.set(JOURNALIST_TAG, { evidence: PRESS_ONLY_EVIDENCE, at: iso(pitched.at)! });
    let connectionTags: string[];
    if (relationScoped) {
      connectionTags = Array.from(new Set((subj?.relation_keys ?? []).flatMap((k) => tagsOfRelation.get(k) ?? []))).sort();
      const personal = connectionTags.find((t) => t.startsWith("personal"));
      if (personal) evidenceOf.set("personal", { evidence: `crm:${personal}`, at: iso(subj?.updated_at ?? null) ?? new Date(0).toISOString() });
    } else {
      const mine = connections.filter((c) => canonOfAtomic.get(c.human) === h);
      connectionTags = Array.from(new Set(mine.map((c) => c.tag))).sort();
      const personalTag = mine.filter((c) => c.tag.startsWith("personal")).sort((a, b) => String(a.at).localeCompare(String(b.at)))[0];
      if (personalTag) evidenceOf.set("personal", { evidence: `crm:${personalTag.tag}`, at: iso(personalTag.at)! });
    }
    const j = judgments.find((x) => x.human === h && x.company_key === key);
    let judgment: { probabilities: Partial<Record<RelationshipTag, number>>; at: string } | null = null;
    if (j) {
      const probabilities: Partial<Record<RelationshipTag, number>> = {};
      // `personal` is crm-service's now: an older judgment of it is not read (PROFESSIONAL-LEADS-1017).
      for (const [k, v] of Object.entries(j.probabilities ?? {})) if (isRelationshipTag(k) && k !== "personal" && typeof v === "number") probabilities[k] = v;
      judgment = { probabilities, at: iso(j.judged_at)! };
    }
    const details = decideTags({ statements: statementsOf, evidence: evidenceOf, judgment });
    let company: RelationshipCompany | null = null;
    if (key) company = { id: key, name: keyNames.get(key)?.name ?? null, domain: keyNames.get(key)?.domain ?? null, source: /^[0-9a-f-]{36}$/i.test(key) && localNamed.has(key) ? "lead" : "crm" };
    const tags = tagsIn(details, "yes");
    const unsureTags = tagsIn(details, "unsure");
    const judgedAt = j ? iso(j.judged_at) : null;
    const isSubject = subj !== null;
    const hasDirect = subj?.has_direct === true;
    const wroteToUs = subj?.wrote_to_us === true;
    const lead = decideLead(details);
    const intent = intents.find((x) => x.human === h && x.company_key === key);
    return {
      humanId: h,
      company,
      tags,
      unsureTags,
      judgedAt,
      details,
      subject: isSubject,
      connectionTags,
      policies: {
        business_only: policyAllows("business_only", { subject: isSubject, hasDirect, tags, unsureTags, judgedAt }),
        pure_prospect: pureProspectAllows({ subject: isSubject, hasDirect, tags, unsureTags, judgedAt }),
      },
      merges: mergesOf.get(h) ?? [],
      wroteToUs,
      lastInboundAt: subj?.last_inbound_at ? iso(subj.last_inbound_at) : null,
      lead,
      wantsBusiness: decideWantsBusiness({
        lead,
        wroteToUs,
        statement: wantsStatement,
        judgment: intent ? { p: Number(intent.p), at: iso(intent.judged_at)! } : null,
      }),
    };
  };

  if (relationKeys !== null) {
    for (const k of relationKeys) {
      const h = canon.get(k.humanId) ?? k.humanId;
      const subj = (subjectsOf.get(h) ?? []).find((r) => r.company_key === k.companyKey) ?? null;
      out.set(subjectKey(k.humanId, k.companyKey), blockOf(h, k.companyKey, subj, true));
    }
    return out;
  }
  for (const h of humans) {
    const rows = subjectsOf.get(h) ?? [];
    // Latest-active relation first (the subjects read is ordered); a human who is no subject reads at ''.
    const blocks = rows.length === 0 ? [blockOf(h, "", null, false)] : rows.map((r) => blockOf(h, r.company_key, r, false));
    const block: RelationshipBlock = {
      ...blocks[0],
      policies: {
        business_only: blocks.every((b) => b.policies.business_only),
        pure_prospect: blocks.every((b) => b.policies.pure_prospect),
      },
      wroteToUs: blocks.some((b) => b.wroteToUs),
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
  /** Leads the judge is unsure WANT to do business with the brand (HOT-INBOUND-UNANSWERED-1016): answer with the `wants_business` tag PUT. */
  intentQuestions: Array<{ humanId: string; name: string | null; answer: IntentAnswerKey; confidence: number | null }>;
  companyQuestions: Array<{ humanId: string; name: string | null; candidates: Array<{ name: string | null; domain: string | null; source: string }> }>;
  settled: {
    merges: SettledMerge[];
    people: Array<{ humanId: string; name: string | null; company: RelationshipCompany | null; tags: RelationshipTag[]; details: TagDetail[] }>;
  };
  counts: {
    subjects: number;
    judged: number;
    byTag: Record<string, number>;
    unsureMerges: number;
    unsureTags: number;
    companyQuestions: number;
    /** People who wrote to the brand, leads among them, and leads who want business (Hot), all among `subjects`. */
    wroteToUs: number;
    leads: number;
    wantsBusiness: number;
    unsureIntent: number;
  };
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
  const subjectRows = (await db.execute(sql`
    SELECT s.human_id::text AS human, s.name FROM relationship_subjects s
    WHERE s.org_id = ${orgId} AND s.brand_id = ${brandId}
      AND (EXISTS (SELECT 1 FROM relationship_judgments j WHERE j.org_id = s.org_id AND j.human_id = s.human_id)
        OR EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.org_id = s.org_id AND e.brand_id = s.brand_id AND e.human_id = s.human_id)
        OR EXISTS (SELECT 1 FROM relationship_statements t WHERE t.org_id = s.org_id AND t.human_id = s.human_id AND t.withdrawn_at IS NULL))
    ORDER BY s.has_messages DESC, s.thread_seq DESC
  `)) as unknown as Array<{ human: string; name: string | null }>;
  // The review asks about a PERSON (one question per human, whatever their relations).
  const seenHumans = new Set<string>();
  const subjects = subjectRows.filter((r) => (seenHumans.has(r.human) ? false : (seenHumans.add(r.human), true)));
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
  const intentQuestions: RelationshipReview["intentQuestions"] = [];
  const intentCounts = { wroteToUs: 0, leads: 0, wantsBusiness: 0 };
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
    if (b.wroteToUs) {
      intentCounts.wroteToUs++;
      if (b.lead.state === "yes") intentCounts.leads++;
      if (b.lead.state === "yes" && b.wantsBusiness.state === "yes") intentCounts.wantsBusiness++;
    }
    if (b.wantsBusiness.state === "unsure") intentQuestions.push({ humanId: s.human, name: s.name, answer: WANTS_BUSINESS, confidence: b.wantsBusiness.confidence });
  }
  // Journalists of the brand nobody's CRM knows (reached only by our press pitches): shown and counted like any tag.
  const subjectHumans = new Set(subjects.map((s) => s.human));
  const journalistRows = (await db.execute(sql`
    SELECT DISTINCT ON (h.human) h.human::text AS human, NULLIF(trim(concat_ws(' ', l.first_name, l.last_name)), '') AS name
    FROM brand_journalists bj
    JOIN leads l ON l.id = bj.lead_id
    CROSS JOIN LATERAL (SELECT ${canonicalHumanSql(sql`${orgId}`, "l")} AS human) h
    WHERE bj.org_id = ${orgId} AND bj.brand_id = ${brandId} AND (bj.journalist OR bj.press_only) AND h.human IS NOT NULL
    ORDER BY h.human, bj.first_pitched_at DESC NULLS LAST
  `)) as unknown as Array<{ human: string; name: string | null }>;
  const outside = journalistRows.filter((r) => !subjectHumans.has(r.human));
  for (let i = 0; i < outside.length; i += 1000) {
    const part = await loadRelationships(orgId, brandId, outside.slice(i, i + 1000).map((r) => r.human));
    for (const r of outside.slice(i, i + 1000)) {
      const b = part.get(r.human);
      if (!b) continue;
      for (const t of b.tags) byTag[t] = (byTag[t] ?? 0) + 1;
      if (b.tags.length > 0 || b.details.some((d) => d.basis === "person")) people.push({ humanId: r.human, name: r.name, company: b.company, tags: b.tags, details: b.details });
    }
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
    intentQuestions,
    companyQuestions: companyRows.map((c) => ({ humanId: c.human, name: nameOf.get(c.human) ?? null, candidates: c.candidates })),
    settled: {
      merges: questions
        .filter((q) => q.state === "linked" && q.link_id)
        .map((q) => ({ linkId: q.link_id!, humanIds: [q.a, q.b], names: [cards.get(q.a)?.name ?? null, cards.get(q.b)?.name ?? null], judgedBy: q.answered_by ?? "jev", confidence: Number(q.probability), at: iso(q.answered_at) ?? "" })),
      people,
    },
    counts: { subjects: Number(total[0]?.n ?? 0), judged, byTag, unsureMerges: open.length, unsureTags: tagQuestions.length, companyQuestions: companyRows.length, ...intentCounts, unsureIntent: intentQuestions.length },
  };
}

export class TagStatementError extends Error {}

/** A person of the org says yes or no about one tag of one human (personal: org-wide; others: this brand's lead). */
export async function stateTag(input: {
  orgId: string;
  brandId: string;
  humanId: string;
  tag: RelationshipTag | IntentAnswerKey;
  state: "yes" | "no";
  userId: string;
  /** The relation (Unibox row) it is said about; absent = the human's latest-active relation. */
  companyKey?: string;
}): Promise<void> {
  const human = (await canonicalHumans(input.orgId, [input.humanId])).get(input.humanId) ?? input.humanId;
  const humanLevel = levelOf(input.tag) === "human";
  const brand = humanLevel ? "" : input.brandId;
  const companyKey = humanLevel ? "" : (input.companyKey ?? (await subjectCompanyKey(input.orgId, input.brandId, human)));
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
  if (input.tag === JOURNALIST_TAG) await refreshJournalistsAfterStatement(input.orgId, input.brandId);
}

/**
 * A person's word on `journalist` moves who the sales pools refuse (brand-journalists.ts): rewrite the brand's rows now.
 * The word itself is already stored; a refresh that fails is logged and redone by the background thread within minutes.
 */
async function refreshJournalistsAfterStatement(orgId: string, brandId: string): Promise<void> {
  try {
    await refreshBrandJournalists({ orgId, brandId });
  } catch (err) {
    console.error(`[lead-service] journalist statement stored but brand ${brandId} not refreshed yet (background thread will):`, err);
  }
}

/** Withdraw a person's word on a tag (back to evidence / judgment). Returns whether one was live. */
export async function withdrawTag(input: {
  orgId: string;
  brandId: string;
  humanId: string;
  tag: RelationshipTag | IntentAnswerKey;
  userId: string;
  /** Only the statement about this relation; absent = every relation of the human. */
  companyKey?: string;
}): Promise<boolean> {
  const human = (await canonicalHumans(input.orgId, [input.humanId])).get(input.humanId) ?? input.humanId;
  const humanLevel = levelOf(input.tag) === "human";
  const onCompany = humanLevel || input.companyKey === undefined ? sql`` : sql`AND company_key = ${input.companyKey}`;
  const rows = (await db.execute(sql`
    UPDATE relationship_statements SET withdrawn_at = now(), withdrawn_by_user_id = ${input.userId}
    WHERE org_id = ${input.orgId} AND brand_id = ${humanLevel ? "" : input.brandId} AND human_id = ${human}::uuid
      AND tag = ${input.tag} AND withdrawn_at IS NULL ${onCompany}
    RETURNING 1
  `)) as unknown as unknown[];
  for (const b of humanLevel ? await brandsOfHuman(input.orgId, human) : [input.brandId]) await recomputePolicy(input.orgId, b, [human]);
  if (input.tag === JOURNALIST_TAG) await refreshJournalistsAfterStatement(input.orgId, input.brandId);
  return rows.length > 0;
}

async function subjectCompanyKey(orgId: string, brandId: string, humanId: string): Promise<string> {
  const rows = (await db.execute(sql`
    SELECT company_key FROM relationship_subjects WHERE org_id = ${orgId} AND brand_id = ${brandId} AND human_id = ${humanId}::uuid
    ORDER BY last_inbound_at DESC NULLS LAST, updated_at DESC, company_key LIMIT 1
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

export interface BrandIntentPerson {
  humanId: string;
  name: string | null;
  /** Lower-cased. */
  emails: string[];
  phones: string[];
  lastInboundAt: string | null;
  lead: LeadAnswer;
  wantsBusiness: WantsBusinessAnswer;
}

/**
 * EVERY person who wrote to the brand, with the two answers (HOT-INBOUND-UNANSWERED-1016): the read features-service
 * builds the Unibox Hot / Won / Lost / Cold families from. Same blocks as the Unibox rows (`loadRelationships`), newest
 * writer first. A person the feed names without a human yet is not here (nobody to key on); they appear once resolved.
 */
export async function readBrandIntent(orgId: string, brandId: string): Promise<BrandIntentPerson[]> {
  // One entry per RELATION (PERSON-RELATIONS-1017): its own addresses and answers, never the human's other relations.
  const rows = (await db.execute(sql`
    SELECT human_id::text AS human, company_key, name, emails, phones FROM relationship_subjects
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND wrote_to_us
    ORDER BY last_inbound_at DESC NULLS LAST, human_id, company_key
  `)) as unknown as Array<{ human: string; company_key: string; name: string | null; emails: string[]; phones: string[] }>;
  const out: BrandIntentPerson[] = [];
  for (let i = 0; i < rows.length; i += 1000) {
    const part = rows.slice(i, i + 1000);
    const blocks = await loadRelationshipsAt(orgId, brandId, part.map((r) => ({ humanId: r.human, companyKey: r.company_key })));
    for (const r of part) {
      const b = blocks.get(subjectKey(r.human, r.company_key));
      if (!b) throw new Error(`[lead-service] relationship block missing for subject ${r.human}@${r.company_key} of brand ${brandId}`);
      out.push({
        humanId: r.human,
        name: r.name,
        emails: Array.from(new Set((r.emails ?? []).map((e) => e.toLowerCase()))),
        phones: r.phones ?? [],
        lastInboundAt: b.lastInboundAt,
        lead: b.lead,
        wantsBusiness: b.wantsBusiness,
      });
    }
  }
  return out;
}
