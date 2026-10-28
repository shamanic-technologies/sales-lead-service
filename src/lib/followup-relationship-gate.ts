/**
 * The relationship policy a CLAIMING workflow states (REPLY-ANY-LEAD-1015, owner 2026-10-15).
 *
 * A reactive pipe (AI Meeting Booking answering whoever writes to the brand on a mirrored channel) must
 * answer a person at once IF they are a lead (prospect) of the brand, and never the owner's personal
 * contacts, the brand's customers, team, investors, partners, suppliers or advisors. WHO a pipe reaches
 * is its strategy's, so the workflow STATES it on `followups/claim-next` (`relationships: "pure_prospect"`),
 * exactly like a sourcing run states `relationships: "business_only"` on its serve. Absent = today's claim,
 * byte for byte.
 *
 * The reading is `policies.pure_prospect` (relationship-tags.ts `pureProspectAllows`, the owner's "leads
 * only": no tag but prospect; a person no source of the org knows outside our outreach is one by
 * definition). Three answers per due person, decided by `decideClaimGate` (pure):
 *
 *  - admit:   claimed as today.
 *  - refuse:  a tag other than prospect is yes OR unsure (`not_a_lead`). FINAL for that due row: the row is
 *             stopped (`followup_stopped_reason = relationship_not_a_lead`) so the queue never offers it again;
 *             a later `scheduled` (they write again) re-enters it and the claim decides again.
 *    A human with several relations at the brand (PERSON-RELATIONS-1017: a gmail address and a work address are
 *    two Unibox rows) is refused when ANY relation holds such a tag (DOCDINNERS-RELATIONSHIP-PENDING-1028): the
 *    per-human block shows the latest-active relation's tags while its policy is AND-ed over every relation, so
 *    reading the tags of one relation alone left a client (customer on their other relation) "pending" forever.
 *  - pending: we cannot say yet, so nobody is answered AND nothing is settled; the row stays due and the next
 *             claim asks again. Never "treat as a lead": no human id yet (`human_unknown`), a CRM fact names the
 *             address but crm-service has not tagged the person yet (`relationship_not_built`; tagged and not
 *             professional to the brand = refused), a
 *             subject never judged that this claim could not judge (`relationship_not_judged`), an open
 *             "same person?" question (`same_person_question_open`, answered on the review page or settled by
 *             the sweep).
 *
 * A subject never judged is JUDGED ON DEMAND inside the claim (Jev, platform-billed through chat-service, the
 * relationship sweep's own `judgeSubject`): one call of a few seconds, so the reply still goes out within the
 * minute instead of waiting up to a sweep tick. At most `ON_DEMAND_JUDGMENTS_PER_CLAIM` per claim (the platform's
 * Jev credit is shared fleet-wide); beyond, or on failure, the person is pending.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { closePlatformRun, createPlatformRun } from "./runs-client.js";
import { judgeSubject } from "./relationship-judge.js";
import { EMPTY_RELATIONSHIP, loadRelationships, loadRelationshipsAt, recomputePolicy, type RelationshipBlock } from "./relationship-read.js";
import { toSubject } from "./relationship-subjects.js";
import { PURE_PROSPECT_EXCLUDED, type RelationshipTag } from "./relationship-tags.js";
import { canonicalE164 } from "./e164-phone.js";
import { crmFactHasEmail, crmFactHasPhone } from "./crm-fact-contact.js";

/**
 * Policies a claim may state: `pure_prospect` (leads only) and `current_client` (clients only, CLIENT-CHECKIN-LEAD-1024,
 * `followup-client-gate.ts`). Never `business_only`: it holds back every never-judged non-subject forever.
 */
export const CLAIM_RELATIONSHIP_POLICIES = ["pure_prospect", "current_client"] as const;
export type ClaimRelationshipPolicy = (typeof CLAIM_RELATIONSHIP_POLICIES)[number];

export function isClaimRelationshipPolicy(v: unknown): v is ClaimRelationshipPolicy {
  return typeof v === "string" && (CLAIM_RELATIONSHIP_POLICIES as readonly string[]).includes(v);
}

/** The one refusal reason, forwarded verbatim by the workflow. */
export const NOT_A_LEAD_REASON = "not_a_lead";
/** What a refused row's `followup_stopped_reason` reads. */
export const RELATIONSHIP_STOP_REASON = "relationship_not_a_lead";

export const CLAIM_PENDING_REASONS = [
  "human_unknown",
  "relationship_not_built",
  "relationship_not_judged",
  "same_person_question_open",
] as const;
export type ClaimPendingReason = (typeof CLAIM_PENDING_REASONS)[number];

/** When asking again can change the answer: the identity sweep, the CRM copy + relationship sweep, a person's answer. */
export const PENDING_RETRY_SECONDS: Record<ClaimPendingReason, number> = {
  human_unknown: 300,
  relationship_not_built: 420,
  relationship_not_judged: 300,
  same_person_question_open: 3600,
};

export const ON_DEMAND_JUDGMENTS_PER_CLAIM = 2;

/** Past this, a person known to the CRM copy and still not built by the sweep is logged as an error (blind spot). */
const NOT_BUILT_LOUD_AFTER_MS = 30 * 60_000;

export type ClaimGateVerdict =
  | { kind: "admit" }
  | { kind: "refuse"; reason: typeof NOT_A_LEAD_REASON; tags: RelationshipTag[]; unsureTags: RelationshipTag[] }
  | { kind: "pending"; reason: ClaimPendingReason; retryAfterSeconds: number }
  /** A subject never judged: judge it, then decide again. */
  | { kind: "judge" };

function pending(reason: ClaimPendingReason): Extract<ClaimGateVerdict, { kind: "pending" }> {
  return { kind: "pending", reason, retryAfterSeconds: PENDING_RETRY_SECONDS[reason] };
}

/**
 * The verdict for one due person under `pure_prospect`. `knownToCrm` = a live CRM fact of the brand carries the
 * claim's address (only asked when the person is not a subject yet). `relations` = the block of EACH relation of the
 * human at the brand (`loadRelationshipsAt`), read alongside the per-human `block`: a tag or an unjudged subject on
 * any of them decides, exactly as the AND-ed policy does.
 */
export function decideClaimGate(block: RelationshipBlock, knownToCrm: boolean, relations: readonly RelationshipBlock[] = []): ClaimGateVerdict {
  if (!block.humanId) return pending("human_unknown");
  const all = [block, ...relations];
  const tags = excludedIn(all.flatMap((b) => b.tags));
  const unsureTags = excludedIn(all.flatMap((b) => b.unsureTags)).filter((t) => !tags.includes(t));
  // A tag stated, evidenced or judged (sure or not) that is not prospect, on any relation: whatever else is unknown, not a lead.
  if (tags.length > 0 || unsureTags.length > 0) return { kind: "refuse", reason: NOT_A_LEAD_REASON, tags, unsureTags };
  // The judge (reading the brand's offers) or crm-service says they are not the brand's lead (LEADS-JUDGE-BRAND-1021).
  if (all.some((b) => b.notBrandLead)) return { kind: "refuse", reason: NOT_A_LEAD_REASON, tags, unsureTags };
  if (block.policies.pure_prospect) {
    // A non-subject is a pure prospect by definition, unless a source of the org knows them: then crm-service's
    // connection tags decide (PROFESSIONAL-LEADS-1017). Not tagged yet = "we do not know", never "a stranger";
    // tagged, but not professional to the brand (personal, professional to someone else) = not a lead.
    if (!block.subject && knownToCrm) {
      if (block.connectionTags.length === 0) return pending("relationship_not_built");
      return { kind: "refuse", reason: NOT_A_LEAD_REASON, tags, unsureTags };
    }
    return { kind: "admit" };
  }
  if (all.some((b) => b.subject && b.judgedAt === null)) return { kind: "judge" };
  return pending("same_person_question_open");
}

function excludedIn(tags: readonly RelationshipTag[]): RelationshipTag[] {
  return PURE_PROSPECT_EXCLUDED.filter((t) => tags.includes(t));
}

/** The block of each relation (human x company) of this human at the brand; none when they are no subject. */
async function relationBlocksOf(orgId: string, brandId: string, block: RelationshipBlock): Promise<RelationshipBlock[]> {
  if (!block.subject || !block.humanId) return [];
  const rows = (await db.execute(sql`
    SELECT company_key FROM relationship_subjects WHERE org_id = ${orgId} AND brand_id = ${brandId} AND human_id = ${block.humanId}::uuid
  `)) as unknown as Array<{ company_key: string }>;
  if (rows.length < 2) return [];
  const keys = rows.map((r) => ({ humanId: block.humanId!, companyKey: r.company_key }));
  return Array.from((await loadRelationshipsAt(orgId, brandId, keys)).values());
}

/**
 * Does a live CRM fact of (org, brand) carry this person? Same predicate as named-person's "known to the brand":
 * the address, or for a person known by phone only (REPLY-PHONE-ONLY-1015) the E.164 phone. A phone-only person
 * the CRM copy names (a WhatsApp writer always is) is therefore never "a stranger" before the sweep builds them.
 */
async function crmFactAge(orgId: string, brandId: string, email: string | null, phone: string | null): Promise<number | null> {
  if (!email) {
    const canonical = canonicalE164(phone);
    if (!canonical) return null;
    const rows = (await db.execute(sql`
      SELECT max(f.received_at) AS at
      FROM crm_facts f
      WHERE f.org_id = ${orgId}
        AND f.brand_id = ${brandId}
        AND f.type <> 'withdrawn'
        AND ${crmFactHasPhone("f", canonical)}
        AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id)
    `)) as unknown as Array<{ at: Date | string | null }>;
    return ageOf(rows[0]?.at);
  }
  const rows = (await db.execute(sql`
    SELECT max(f.received_at) AS at
    FROM crm_facts f
    WHERE f.org_id = ${orgId}
      AND f.brand_id = ${brandId}
      AND f.type <> 'withdrawn'
      AND ${crmFactHasEmail("f", email.trim().toLowerCase())}
      AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id)
  `)) as unknown as Array<{ at: Date | string | null }>;
  return ageOf(rows[0]?.at);
}

function ageOf(at: Date | string | null | undefined): number | null {
  if (at === null || at === undefined) return null;
  const ms = new Date(at).getTime();
  return Number.isNaN(ms) ? 0 : Date.now() - ms;
}

export async function blockOfLead(orgId: string, brandId: string, leadId: string): Promise<RelationshipBlock> {
  const rows = (await db.execute(sql`SELECT human_id::text AS h FROM leads WHERE id = ${leadId}::uuid`)) as unknown as Array<{ h: string | null }>;
  const h = rows[0]?.h ?? null;
  if (!h) return EMPTY_RELATIONSHIP;
  return (await loadRelationships(orgId, brandId, [h])).get(h) ?? { ...EMPTY_RELATIONSHIP, humanId: h };
}

/**
 * The per-human block with the tags of EVERY relation of the human at the brand (a sure tag on one relation wins over
 * the same tag unsure on another): what a claim gate reading tags off the block must see (`current_client`'s team and
 * personal refusals), since the block alone shows the latest-active relation's tags (DOCDINNERS-RELATIONSHIP-PENDING-1028).
 */
export async function blockOfLeadEveryRelation(orgId: string, brandId: string, leadId: string): Promise<RelationshipBlock> {
  const block = await blockOfLead(orgId, brandId, leadId);
  const relations = await relationBlocksOf(orgId, brandId, block);
  if (relations.length === 0) return block;
  const all = [block, ...relations];
  const tags = Array.from(new Set(all.flatMap((b) => b.tags)));
  const unsureTags = Array.from(new Set(all.flatMap((b) => b.unsureTags))).filter((t) => !tags.includes(t));
  return { ...block, tags, unsureTags };
}

/** Judges what one claim may still afford, and the platform run they hang from (opened on first use). */
export class ClaimJudgeBudget {
  private left: number;
  private run: { id: string } | null = null;
  constructor(private readonly runId: string | null, judgments = ON_DEMAND_JUDGMENTS_PER_CLAIM) {
    this.left = judgments;
  }
  take(): boolean {
    if (this.left <= 0) return false;
    this.left--;
    return true;
  }
  async runIdForJudgment(): Promise<string> {
    if (this.runId) return this.runId;
    if (!this.run) this.run = await createPlatformRun("followup-claim-relationship-judgment");
    return this.run.id;
  }
  async close(): Promise<void> {
    if (this.run) await closePlatformRun(this.run.id, "completed").catch((e) => console.error("[lead-service] claim judgment run close failed:", e));
  }
}

/** Judge every never-judged subject row of this human at the brand; false = could not (nothing written). */
async function judgeOnDemand(orgId: string, brandId: string, humanId: string, budget: ClaimJudgeBudget): Promise<boolean> {
  if (!budget.take()) return false;
  try {
    const rows = (await db.execute(sql`
      SELECT s.* FROM relationship_subjects s
      LEFT JOIN relationship_judgments j ON j.org_id = s.org_id AND j.brand_id = s.brand_id AND j.human_id = s.human_id AND j.company_key = s.company_key
      WHERE s.org_id = ${orgId} AND s.brand_id = ${brandId} AND s.human_id = ${humanId}::uuid AND j.human_id IS NULL
    `)) as unknown as Array<Record<string, unknown>>;
    if (rows.length === 0) return true;
    const runId = await budget.runIdForJudgment();
    for (const r of rows) await judgeSubject(toSubject(r), runId);
    await recomputePolicy(orgId, brandId, [humanId]);
    return true;
  } catch (err) {
    console.error(`[lead-service] followup claim: on-demand relationship judgment failed org=${orgId} brand=${brandId} human=${humanId}:`, err);
    return false;
  }
}

/** The verdict for one due person, judging a never-judged subject on demand. Any read failure throws (the claim 502s). */
export async function gateFollowupCandidate(p: {
  orgId: string;
  brandId: string;
  leadId: string;
  /** Null for a person known by phone only (then `phone` identifies them). */
  email: string | null;
  phone?: string | null;
  budget: ClaimJudgeBudget;
}): Promise<Exclude<ClaimGateVerdict, { kind: "judge" }>> {
  let block = await blockOfLead(p.orgId, p.brandId, p.leadId);
  const needsCrm = block.humanId !== null && !block.subject;
  const age = needsCrm ? await crmFactAge(p.orgId, p.brandId, p.email, p.phone ?? null) : null;
  let verdict = decideClaimGate(block, age !== null, await relationBlocksOf(p.orgId, p.brandId, block));
  if (verdict.kind === "judge") {
    const judged = await judgeOnDemand(p.orgId, p.brandId, block.humanId!, p.budget);
    if (!judged) return pending("relationship_not_judged");
    block = await blockOfLead(p.orgId, p.brandId, p.leadId);
    verdict = decideClaimGate(block, age !== null, await relationBlocksOf(p.orgId, p.brandId, block));
    if (verdict.kind === "judge") return pending("relationship_not_judged");
  }
  if (verdict.kind === "pending" && verdict.reason === "same_person_question_open") {
    // Every way the AND-ed policy can refuse is read above; reaching here means a new one was added without its verdict.
    console.error(`[lead-service] followup claim: lead ${p.leadId} (human ${block.humanId}) held by pure_prospect with no tag, verdict or unjudged relation to explain it`);
  }
  if (verdict.kind === "pending" && verdict.reason === "relationship_not_built" && age !== null && age > NOT_BUILT_LOUD_AFTER_MS) {
    console.error(
      `[lead-service] followup claim: ${p.email ?? `phone ${p.phone}`} (lead ${p.leadId}) is known to brand ${p.brandId}'s CRM copy for ${Math.round(age / 60_000)} min and the relationship sweep has not built them: held, never answered as a lead`,
    );
  }
  return verdict;
}

/** Errors the claim reads as "relationships cannot be read": 502, nobody claimed. */
export class ClaimRelationshipUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`[followup-queue] relationships unavailable: ${String(cause)}`);
    this.name = "ClaimRelationshipUnavailableError";
  }
}
