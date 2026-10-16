/**
 * WHO a person is to a brand (RELATIONSHIP-TAGS-1014, owner 2026-10-14): the vocabulary, the levels,
 * and the one place a tag's state is decided from its three bases. Pure.
 *
 * Levels: `personal` is about the org and the HUMAN (shown on every row of that human, every brand);
 * every other tag is about the org, the brand and the LEAD (the human at a company).
 *
 * Bases, read with precedence person > evidence > judgment:
 *   - a person of the org said yes or no (review page, MCP): that is the answer, withdrawable;
 *   - a source stated a fact (signup -> prospect, payment / sale -> customer, reached ONLY through a press pitch ->
 *     journalist, src/lib/brand-journalists.ts): yes;
 *   - Jev judged the person's whole merged thread: more likely than not (>= JUDGED_YES, 50%) is a yes,
 *     below JUDGED_NO (40%) a no, the true doubt between is a question for the owner (owner 2026-10-14,
 *     RELATIONSHIP-TAGS-1014b: the same edges as a merge, `relationship-merges.ts`).
 * Several tags are yes at once (Advisor + Customer, Personal + Customer): tags are additive.
 */

export const RELATIONSHIP_TAGS = [
  "personal",
  "customer",
  "prospect",
  "team",
  "investor",
  "advisor",
  "supplier",
  "partner",
  "other_professional",
  // JOURNALISTS-NOT-LEADS-1016 (owner 2026-10-16): a person the brand pitches to the PRESS, never a lead. Evidence =
  // reached ONLY through a press pitch (src/lib/brand-journalists.ts); no sales pipe ever hands one out.
  "journalist",
] as const;
export type RelationshipTag = (typeof RELATIONSHIP_TAGS)[number];

export type RelationshipLevel = "human" | "lead";

export function levelOf(tag: string): RelationshipLevel {
  return tag === "personal" ? "human" : "lead";
}

export function isRelationshipTag(v: unknown): v is RelationshipTag {
  return typeof v === "string" && (RELATIONSHIP_TAGS as readonly string[]).includes(v);
}

/**
 * The relationship policy a PIPE states on its serve (`relationships: "business_only"`, the tactic
 * "Business contacts only"): nobody the brand knows outside business-to-customer is handed out, and
 * nobody whose thread was never judged (never assume we do not know them).
 */
export const RELATIONSHIP_POLICIES = ["business_only"] as const;
export type RelationshipPolicy = (typeof RELATIONSHIP_POLICIES)[number];
export const BUSINESS_ONLY_EXCLUDED: readonly RelationshipTag[] = ["personal", "investor", "supplier", "team", "partner", "advisor", "journalist"];

/**
 * A PURE PROSPECT (NEVER-NO-FOLLOWUP-1014, owner 2026-10-14: "qui n'ont pas de tag autre, pas personal, pas client,
 * pas investors, pure prospect"): no tag but `prospect`, yes or unsure.
 */
export const PURE_PROSPECT_EXCLUDED: readonly RelationshipTag[] = RELATIONSHIP_TAGS.filter((t) => t !== "prospect");

export const JUDGED_YES = 0.5;
/** Below this a judgment is a no; from it up to JUDGED_YES it is unsure. */
export const JUDGED_NO = 0.4;

export type TagState = "yes" | "no" | "unsure";
export type TagBasis = "evidence" | "judgment" | "person";

export interface TagDetail {
  tag: RelationshipTag;
  level: RelationshipLevel;
  state: TagState;
  basis: TagBasis;
  confidence: number | null;
  evidence: string | null;
  at: string;
}

export interface TagInputs {
  /** Live person statements, by tag. */
  statements: Map<RelationshipTag, { state: "yes" | "no"; at: string }>;
  /** Evidence rows, by tag. */
  evidence: Map<RelationshipTag, { evidence: string; at: string }>;
  /** Jev's yes-probabilities for the lead (personal: the highest over the org's brands). */
  judgment: { probabilities: Partial<Record<RelationshipTag, number>>; at: string } | null;
}

export function judgedState(p: number): TagState {
  if (p >= JUDGED_YES) return "yes";
  if (p < JUDGED_NO) return "no";
  return "unsure";
}

/** Every tag's decided state, one detail per tag that any basis speaks about. */
export function decideTags(input: TagInputs): TagDetail[] {
  const out: TagDetail[] = [];
  for (const tag of RELATIONSHIP_TAGS) {
    const level = levelOf(tag);
    const st = input.statements.get(tag);
    if (st) {
      out.push({ tag, level, state: st.state, basis: "person", confidence: null, evidence: null, at: st.at });
      continue;
    }
    const ev = input.evidence.get(tag);
    if (ev) {
      out.push({ tag, level, state: "yes", basis: "evidence", confidence: null, evidence: ev.evidence, at: ev.at });
      continue;
    }
    const p = input.judgment?.probabilities[tag];
    if (input.judgment && typeof p === "number") {
      out.push({ tag, level, state: judgedState(p), basis: "judgment", confidence: p, evidence: null, at: input.judgment.at });
    }
  }
  return out;
}

export function tagsIn(details: readonly TagDetail[], state: TagState): RelationshipTag[] {
  return details.filter((d) => d.state === state).map((d) => d.tag);
}

/**
 * May a pipe stating `policy` hand this person out? Never judged = no (we never assume a stranger);
 * any excluded tag that is yes = no. An excluded tag still UNSURE also holds them back: the owner
 * has not said they are only business.
 */
export function policyAllows(
  policy: RelationshipPolicy,
  block: { tags: readonly RelationshipTag[]; unsureTags: readonly RelationshipTag[]; judgedAt: string | null; openMerge?: boolean },
): boolean {
  if (policy !== "business_only") return true;
  if (block.judgedAt === null) return false;
  // "Are they the same person as someone we talk with?" still unanswered: they may be known (never assume a stranger).
  if (block.openMerge) return false;
  return !BUSINESS_ONLY_EXCLUDED.some((t) => block.tags.includes(t) || block.unsureTags.includes(t));
}

/**
 * Is this person a PURE PROSPECT of the brand (NEVER-NO-FOLLOWUP-1014)? A relationship SUBJECT of the brand (some
 * source of the org knows them: CRM, mailbox, WhatsApp...) only once judged, with no open "same person?" question and
 * no tag but prospect, yes or unsure. A person NO source of the org knows outside our own outreach (not a subject) is
 * one by definition, no judgment asked (owner's definition, relayed 2026-10-14): only a tag stated or judged elsewhere
 * (`personal`, org-wide) or an open question holds them back.
 */
export function pureProspectAllows(block: {
  subject: boolean;
  tags: readonly RelationshipTag[];
  unsureTags: readonly RelationshipTag[];
  judgedAt: string | null;
  openMerge?: boolean;
}): boolean {
  if (block.subject && block.judgedAt === null) return false;
  if (block.openMerge) return false;
  return !PURE_PROSPECT_EXCLUDED.some((t) => block.tags.includes(t) || block.unsureTags.includes(t));
}
