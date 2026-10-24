/**
 * The `current_client` claim policy (CLIENT-CHECKIN-LEAD-1024, owner 2026-10-24: « A chaque event de l'Unibox pour un
 * client actuel (non perso) une campagne réactive se déclenche pour se demander si ça lui écrit pour un check-in ou
 * l'accompagner pour avoir plus de valeur avec le service »).
 *
 * The opposite of `pure_prospect`: a client check-in pipe states `relationships: "current_client"` on
 * `followups/claim-next` and is handed a due person ONLY if they are a CURRENT CLIENT of the brand. Owner definition:
 * a person the brand knows as a professional customer who PAID the brand (a live, attributed sale/purchase on the
 * outcome ledger at the brand: the same "won" as `/orgs/brands/{brandId}/won-leads`, any lead of the same human),
 * never a personal contact, never the org's own team, never staff or our test users. Under this policy the follow-up
 * loop's booked-meeting stop does not apply (a client has a sale: that stop would hide every one of them).
 *
 * Three answers per due person, decided by `decideClientGate` (pure), strongest refusal first:
 *  - refuse `staff`        an address of the person is fleet staff or a test user (`isStaffEmail`).
 *  - refuse `team_member`  a member of the org owning the brand (client-service, `org-members.ts`), or `team` tagged
 *                          yes/unsure: a member who paid on the product while testing is still no client.
 *  - refuse `not_a_client` no live sale on the ledger at the brand.
 *  - pending `human_unknown` no human id yet: whether they are a personal contact cannot be read yet.
 *  - refuse `personal`     `personal` yes OR unsure (crm-service's `personal_*` tag or a person's word).
 *  - admit.
 * A refusal is FINAL for the due row (stopped, `followup_stopped_reason = relationship_<reason>`); a pending leaves it
 * due. Never "treat as a client" when undecidable. Any read failing throws (the claim 502s).
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { SALE_STEP } from "./closed-deal.js";
import { isStaffEmail } from "./staff-identity.js";
import { anyMemberAddress } from "./org-members.js";
import type { RelationshipBlock } from "./relationship-read.js";
import type { RelationshipTag } from "./relationship-tags.js";

export const CLIENT_REFUSAL_REASONS = ["staff", "team_member", "not_a_client", "personal"] as const;
export type ClientRefusalReason = (typeof CLIENT_REFUSAL_REASONS)[number];

/** Every stored spelling of a sale (legacy `purchase` included), as `won-leads` reads it. */
const SALE_SPELLINGS: string[] = [SALE_STEP, "purchase"];

export interface ClientGateFacts {
  block: RelationshipBlock;
  /** Every address registered to the lead (any case). */
  emails: readonly string[];
  /** A live, attributed sale at (org, brand) for this row, this lead, or another lead of the same human. */
  paid: boolean;
  /** Member address keys of the org owning the brand (`loadOrgMemberKeys`). */
  memberKeys: ReadonlySet<string>;
}

export type ClientGateVerdict =
  | { kind: "admit" }
  | { kind: "refuse"; reason: ClientRefusalReason; tags: RelationshipTag[]; unsureTags: RelationshipTag[] }
  | { kind: "pending"; reason: "human_unknown" };

function heldTag(block: RelationshipBlock, tag: RelationshipTag): { tags: RelationshipTag[]; unsureTags: RelationshipTag[] } | null {
  const yes = block.tags.includes(tag);
  const unsure = block.unsureTags.includes(tag);
  if (!yes && !unsure) return null;
  return { tags: yes ? [tag] : [], unsureTags: unsure ? [tag] : [] };
}

export function decideClientGate(f: ClientGateFacts): ClientGateVerdict {
  if (f.emails.some((e) => isStaffEmail(e))) return { kind: "refuse", reason: "staff", tags: [], unsureTags: [] };
  if (anyMemberAddress(f.emails, f.memberKeys)) return { kind: "refuse", reason: "team_member", tags: [], unsureTags: [] };
  const team = heldTag(f.block, "team");
  if (team) return { kind: "refuse", reason: "team_member", ...team };
  if (!f.paid) return { kind: "refuse", reason: "not_a_client", tags: [], unsureTags: [] };
  if (!f.block.humanId) return { kind: "pending", reason: "human_unknown" };
  const personal = heldTag(f.block, "personal");
  if (personal) return { kind: "refuse", reason: "personal", ...personal };
  return { kind: "admit" };
}

/** The lead's registered addresses and whether the person paid the brand. One statement. */
export async function loadClientFacts(p: {
  orgId: string;
  brandId: string;
  leadId: string;
  leadCampaignId: string;
}): Promise<{ emails: string[]; paid: boolean }> {
  const rows = (await db.execute(sql`
    SELECT
      COALESCE((SELECT array_agg(DISTINCT lower(trim(cm.value))) FROM lead_contact_methods cm
                WHERE cm.lead_id = ${p.leadId}::uuid AND cm.channel = 'email'), ARRAY[]::text[]) AS emails,
      EXISTS (
        SELECT 1 FROM conversion_events ce
        WHERE ce.org_id = ${p.orgId}
          AND ce.brand_id = ${p.brandId}
          AND ce.event = ANY(${sql.param(SALE_SPELLINGS)}::text[])
          AND ce.attribution_status = 'attributed'
          AND ce.withdrawn_at IS NULL
          AND (
            ce.lead_campaign_id = ${p.leadCampaignId}::uuid
            OR ce.matched_lead_id = ${p.leadId}::uuid
            OR ce.matched_lead_id IN (
              SELECT l2.id FROM leads l1 JOIN leads l2 ON l2.human_id = l1.human_id
              WHERE l1.id = ${p.leadId}::uuid AND l1.human_id IS NOT NULL
            )
          )
      ) AS paid
  `)) as unknown as Array<{ emails: string[] | null; paid: boolean | null }>;
  return { emails: rows[0]?.emails ?? [], paid: Boolean(rows[0]?.paid) };
}
