/**
 * "Same person?" answers this org stated (RELATIONSHIP-TAGS-1014). Since PROFESSIONAL-LEADS-1017 (owner 2026-10-17)
 * lead-service no longer ASKS it: crm-service and human-service own merges. What stays: the org view of each human
 * (`refreshOrgAliases`, followed by human-events.ts) and a person's answer / undo on a question or link stated here
 * before, until the review page drops them.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { getHumanInOrg, stateHumanLink, withdrawHumanLink } from "./human-identity-client.js";

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
