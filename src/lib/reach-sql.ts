import { sql, type SQL } from "drizzle-orm";
import type { ReachMethod } from "./people-client.js";
import { emailPolicyClause, type PoolEmailPolicy } from "./email-policy.js";
import type { RelationshipPolicy } from "./relationship-tags.js";

/**
 * `AND EXISTS (...)` per contact method the serving pipe needs (src/lib/channel-reach.ts), on the lead the row names.
 * Email is always required (a served lead carries one: lead-service's served contract), so with no reach stated the
 * fragment is exactly the email check every pool already made. Methods are the stored `lead_contact_methods.channel`
 * words (`email`, `phone`). The pipe's email policy (src/lib/email-policy.ts, absent = `valid_only`) keeps out a lead
 * whose address carries a verdict it refuses (a catch-all person never reaches a valid-only campaign from a pool).
 */
export function reachClauses(
  leadId: SQL,
  reachableBy: readonly ReachMethod[] | null | undefined,
  acceptedEmails?: PoolEmailPolicy | null,
  relationships?: RelationshipScope | null,
): SQL {
  const methods = [...new Set<ReachMethod>(["email", ...(reachableBy ?? [])])].sort();
  return sql.join(
    [
      ...methods.map(
        (m) => sql`AND EXISTS (SELECT 1 FROM lead_contact_methods cm_r WHERE cm_r.lead_id = ${leadId} AND cm_r.channel = ${m})`,
      ),
      emailPolicyClause(leadId, acceptedEmails),
      relationshipClause(leadId, relationships ?? null),
    ],
    sql` `,
  );
}

/** The pipe's relationship policy and the brand(s) it serves for (RELATIONSHIP-TAGS-1014). */
export interface RelationshipScope {
  policy: RelationshipPolicy;
  orgId: string;
  brandIds: readonly string[];
}

/**
 * `business_only`: only a lead whose human (this org's view) is a relationship subject of the brand decided
 * fit for it (`relationship_subjects.business_only_ok`, fail-closed: never judged = no). Nothing stated = empty.
 */
export function relationshipClause(leadId: SQL, scope: RelationshipScope | null): SQL {
  if (!scope || scope.brandIds.length === 0) return sql``;
  return sql`AND EXISTS (
    SELECT 1 FROM leads l_rel
    JOIN relationship_subjects s_rel ON s_rel.org_id = ${scope.orgId}
      AND s_rel.brand_id = ANY(${sql.param([...scope.brandIds])}::text[])
      AND s_rel.human_id = COALESCE(
        (SELECT o_rel.human_id FROM org_human_aliases o_rel WHERE o_rel.org_id = ${scope.orgId} AND o_rel.atomic_human_id = l_rel.human_id),
        l_rel.human_id)
    WHERE l_rel.id = ${leadId} AND s_rel.business_only_ok)`;
}
