/**
 * "Are these two the same person?" for people nothing ties together (RELATIONSHIP-TAGS-1014, owner
 * 2026-10-14): a WhatsApp "Yulia (WA)" with no email and no shared phone, and "Yuliia Siletska" who
 * signed up. human-service decides "same human" and holds every link; this module only ASKS Jev and
 * STATES the answer there, in the org's own view (a judgment never merges the fleet):
 *   - candidates: each subject of the brand with NO email and a real name, against the brand's
 *     subjects WITH an email, picked by name blocking (`relationship-names.ts`), never a rule on words;
 *   - Jev reads both people (names, keys, channels, both threads) and gives P(same);
 *   - >= LINK_AT: an org link judged by "jev" (undoable from the review page);
 *     >= ASK_AT: a question for the owner; below: recorded as rejected, never asked again.
 * Every pair is judged ONCE (`relationship_merge_questions`, unique per org and pair).
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { getHumanInOrg, stateHumanLink, withdrawHumanLink } from "./human-identity-client.js";
import { judgeYesNo } from "./qualification-judge.js";
import { fitThread } from "./relationship-judge.js";
import { candidatesFor, hasComparableName, type NamedPerson } from "./relationship-names.js";
import { readThread, toSubject, type Scope, type Subject } from "./relationship-subjects.js";
import type { SpendIdentity } from "./treg-client.js";

export const LINK_AT = 0.9;
export const ASK_AT = 0.4;
const PAIRS_PER_TICK = 40;
const MAX_CANDIDATES = 3;

const SAME_PERSON = {
  instructions:
    "Are `a` and `b` the SAME real person? They come from different channels of one brand (for example a WhatsApp " +
    "contact or group member, and someone who signed up or emailed). Compare names across spellings, alphabets and " +
    "nicknames (Yulia / Yuliia / Julia / Юля; Dima / Dmytro), the company, emails or phone numbers either side " +
    "mentions, places, and what each thread says. A shared first name alone is weak evidence.",
  whenTrue: "Everything shown fits one person and something specific ties them (full name, email or phone mentioned, same company, same story).",
  whenFalse: "They are different people, or nothing beyond a common first name ties them.",
};

async function card(s: Subject): Promise<Record<string, unknown>> {
  return { name: s.name, emails: s.emails, phones: s.phones, channels: s.channels, thread: fitThread(await readThread(s), 30_000) };
}

export function orderPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

/** Re-read the org view of these humans and record which atomic id now names which human. */
export async function refreshOrgAliases(orgId: string, humanIds: readonly string[]): Promise<void> {
  for (const id of new Set(humanIds)) {
    const view = await getHumanInOrg(id, orgId);
    const members = view ? Array.from(new Set([...view.memberHumanIds, view.humanId])) : [id];
    const canonical = view?.humanId ?? id;
    await db.execute(sql`
      DELETE FROM org_human_aliases WHERE org_id = ${orgId}
        AND (atomic_human_id = ANY(${sql.param([...members, id])}::uuid[]) OR human_id = ANY(${sql.param([...members, id])}::uuid[]))
    `);
    if (members.length > 1) {
      await db.execute(sql`
        INSERT INTO org_human_aliases (org_id, atomic_human_id, human_id)
        SELECT ${orgId}, m, ${canonical}::uuid FROM unnest(${sql.param(members)}::uuid[]) AS m
        ON CONFLICT (org_id, atomic_human_id) DO UPDATE SET human_id = excluded.human_id, updated_at = now()
      `);
      // A person's word on the absorbed human now speaks for the merged one (unless it said something there already).
      await db.execute(sql`
        UPDATE relationship_statements s SET human_id = ${canonical}::uuid
        WHERE s.org_id = ${orgId} AND s.human_id = ANY(${sql.param(members)}::uuid[]) AND s.human_id <> ${canonical}::uuid
          AND s.withdrawn_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM relationship_statements x WHERE x.org_id = s.org_id AND x.brand_id = s.brand_id
            AND x.human_id = ${canonical}::uuid AND x.company_key = s.company_key AND x.tag = s.tag AND x.withdrawn_at IS NULL)
      `);
    }
  }
}

interface Pair {
  unlinked: Subject;
  known: Subject;
}

async function pendingPairs(scope: Scope): Promise<Pair[]> {
  const rows = (await db.execute(sql`
    SELECT * FROM relationship_subjects WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId}
  `)) as unknown as Array<Record<string, unknown>>;
  const subjects = rows.map(toSubject);
  const known = subjects.filter((s) => s.emails.length > 0);
  const unlinked = subjects.filter((s) => s.emails.length === 0 && hasComparableName(s.name));
  if (known.length === 0 || unlinked.length === 0) return [];
  const asked = (await db.execute(sql`
    SELECT human_a::text AS a, human_b::text AS b FROM relationship_merge_questions WHERE org_id = ${scope.orgId}
  `)) as unknown as Array<{ a: string; b: string }>;
  const askedSet = new Set(asked.map((r) => `${r.a}|${r.b}`));
  const byId = new Map(subjects.map((s) => [s.humanId, s]));
  const knownNamed: NamedPerson[] = known.map((k) => ({ humanId: k.humanId, name: k.name, emails: k.emails }));
  const out: Pair[] = [];
  for (const u of unlinked) {
    for (const c of candidatesFor({ humanId: u.humanId, name: u.name, emails: [] }, knownNamed, MAX_CANDIDATES)) {
      const [a, b] = orderPair(u.humanId, c.person.humanId);
      if (askedSet.has(`${a}|${b}`)) continue;
      out.push({ unlinked: u, known: byId.get(c.person.humanId)! });
      if (out.length >= PAIRS_PER_TICK) return out;
    }
  }
  return out;
}

export interface MergeTick {
  asked: number;
  linked: number;
  open: number;
  rejected: number;
}

export async function suggestMerges(scope: Scope, id: SpendIdentity): Promise<MergeTick> {
  const tick: MergeTick = { asked: 0, linked: 0, open: 0, rejected: 0 };
  for (const p of await pendingPairs(scope)) {
    const state = { a: await card(p.unlinked), b: await card(p.known) };
    const { probabilities, model } = await judgeYesNo(state, { same: SAME_PERSON }, id);
    const prob = probabilities.same;
    const [a, b] = orderPair(p.unlinked.humanId, p.known.humanId);
    const st: "linked" | "open" | "rejected" = prob >= LINK_AT ? "linked" : prob >= ASK_AT ? "open" : "rejected";
    let linkId: string | null = null;
    if (st === "linked") {
      const r = await stateHumanLink({
        orgId: scope.orgId,
        relation: "same",
        humanIds: [a, b],
        judgedBy: "jev",
        evidence: `lead-service relationship sweep: Jev P(same)=${prob.toFixed(3)} (${model}) for "${p.unlinked.name}" and "${p.known.name}"`,
      });
      linkId = r.link?.linkId ?? null;
      await refreshOrgAliases(scope.orgId, [a, b]);
    }
    await db.execute(sql`
      INSERT INTO relationship_merge_questions (org_id, brand_id, human_a, human_b, probability, model, run_id, state, link_id, answered_by, answered_at)
      VALUES (${scope.orgId}, ${scope.brandId}, ${a}::uuid, ${b}::uuid, ${prob}, ${model}, ${id.runId}, ${st}, ${linkId},
        ${st === "linked" ? "jev" : null}, ${st === "linked" ? new Date().toISOString() : null}::timestamptz)
      ON CONFLICT (org_id, human_a, human_b) DO NOTHING
    `);
    tick.asked++;
    if (st === "linked") tick.linked++;
    else if (st === "open") tick.open++;
    else tick.rejected++;
  }
  return tick;
}

export class MergeQuestionNotFoundError extends Error {}

/** The owner answers an open question: yes = an org link judged by them; no = a "distinct" link. */
export async function answerMergeQuestion(input: { orgId: string; brandId: string; questionId: string; same: boolean; userId: string }): Promise<{ state: string; linkId: string | null }> {
  const rows = (await db.execute(sql`
    SELECT human_a::text AS a, human_b::text AS b, state FROM relationship_merge_questions
    WHERE id = ${input.questionId}::uuid AND org_id = ${input.orgId} AND brand_id = ${input.brandId}
  `)) as unknown as Array<{ a: string; b: string; state: string }>;
  const q = rows[0];
  if (!q) throw new MergeQuestionNotFoundError(input.questionId);
  const r = await stateHumanLink({
    orgId: input.orgId,
    relation: input.same ? "same" : "distinct",
    humanIds: [q.a, q.b],
    judgedBy: `person:${input.userId}`,
    evidence: `answered on the relationship review page (lead-service merge question ${input.questionId})`,
  });
  const state = input.same ? "linked" : "distinct";
  const linkId = r.link?.linkId ?? null;
  await db.execute(sql`
    UPDATE relationship_merge_questions SET state = ${state}, link_id = ${linkId}, answered_by = ${`person:${input.userId}`}, answered_at = now()
    WHERE id = ${input.questionId}::uuid
  `);
  await refreshOrgAliases(input.orgId, [q.a, q.b]);
  return { state, linkId };
}

/** Undo a merge stated here (by Jev or a person): the link is withdrawn at human-service, the pair is not asked again. */
export async function undoMerge(input: { orgId: string; brandId: string; linkId: string; userId: string }): Promise<{ changed: boolean }> {
  const rows = (await db.execute(sql`
    SELECT id::text, human_a::text AS a, human_b::text AS b FROM relationship_merge_questions
    WHERE org_id = ${input.orgId} AND link_id = ${input.linkId}
  `)) as unknown as Array<{ id: string; a: string; b: string }>;
  if (rows.length === 0) throw new MergeQuestionNotFoundError(input.linkId);
  const r = await withdrawHumanLink(input.linkId, input.orgId, `person:${input.userId}`, "undone on the relationship review page");
  await db.execute(sql`
    UPDATE relationship_merge_questions SET state = 'rejected', answered_by = ${`person:${input.userId}`}, answered_at = now()
    WHERE org_id = ${input.orgId} AND link_id = ${input.linkId}
  `);
  await refreshOrgAliases(input.orgId, [rows[0].a, rows[0].b]);
  return { changed: r.changed };
}
