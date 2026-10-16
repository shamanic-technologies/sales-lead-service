/**
 * Every PROSPECT a brand talks with in the Unibox is a lead of that brand (LEAD-FOLLOWUP-DATE-1016, owner 2026-10-16:
 * "100% des leads" carry a next follow-up date, and before this a person known only from the Unibox, who wrote to the
 * brand on WhatsApp, LinkedIn or Gmail, was no lead at all, so nothing could ever follow them up; owner 2026-10-11:
 * "100% des personnes qui parlent au chat devraient être des leads").
 *
 * GENERIC, never a per-brand path. Who the brand talks with is the relationship layer's subject list (built from
 * crm-service's fact copy, every source: relationship-sweep.ts): a subject with a DIRECT conversation (`has_direct`, not
 * a group roster lurker) holding messages. Only a PURE PROSPECT is filed (`policies.pure_prospect`: judged, no tag but
 * prospect, no open "same person?" question): a friend, a client, a teammate, an investor is a conversation the owner
 * never wants followed up, and stays no lead of ours. A subject not judged yet waits for the relationship sweep.
 *
 * Filed like a signup (brand-signups.ts `fileBrandIntakePerson`): email-first lead (the address owner, else a new lead),
 * ONE `served` row under the brand's own intake `unibox:<brandId>`, `status_reason = 'unibox_conversation'`, dated when
 * the subject was first seen. A person who is already a lead of the brand (by human or by address) is left alone. A
 * subject with no email is not filed: the served contract is email-first (root CLAUDE.md), so no pipe could hand them.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { fileBrandIntakePerson } from "./brand-signups.js";
import { loadRelationships } from "./relationship-read.js";
import { toIsoTimestamp } from "./basic-leads.js";

export const UNIBOX_INTAKE_SOURCE = "unibox_conversation";
const CANDIDATE_LIMIT = 2_000;

export function uniboxIntakeCampaignId(brandId: string): string {
  return `unibox:${brandId}`;
}

interface Candidate {
  org_id: string;
  brand_id: string;
  human_id: string;
  name: string | null;
  emails: string[];
  first_seen_at: Date | string;
}

export interface UniboxIntakeResult {
  candidates: number;
  filed: number;
  notProspect: number;
  ambiguous: number;
}

/** File every Unibox pure prospect that is not a lead of its brand yet (of one brand when scoped). */
export async function fileUniboxLeads(scope: { orgId: string; brandId: string } | null = null): Promise<UniboxIntakeResult> {
  const result: UniboxIntakeResult = { candidates: 0, filed: 0, notProspect: 0, ambiguous: 0 };
  // Keyset walk: a subject refused today (not a pure prospect) stays a candidate and must not hide the ones after it.
  let after: { at: string; human: string } | null = null;
  for (;;) {
    const page = await candidatePage(scope, after);
    if (page.length === 0) break;
    await fileCandidates(page, result);
    const last = page[page.length - 1];
    after = { at: toIsoTimestamp(last.first_seen_at)!, human: last.human_id };
    if (page.length < CANDIDATE_LIMIT) break;
  }
  return result;
}

async function candidatePage(scope: { orgId: string; brandId: string } | null, after: { at: string; human: string } | null): Promise<Candidate[]> {
  return (await db.execute(sql`
    SELECT s.org_id, s.brand_id, s.human_id::text AS human_id, s.name, s.emails, s.first_seen_at
    FROM relationship_subjects s
    WHERE s.has_direct AND s.has_messages AND cardinality(s.emails) > 0
      AND (${scope?.orgId ?? null}::text IS NULL OR (s.org_id = ${scope?.orgId ?? null} AND s.brand_id = ${scope?.brandId ?? null}))
      AND NOT EXISTS (
        SELECT 1 FROM leads l
        JOIN leads_campaigns lc ON lc.lead_id = l.id AND lc.org_id = s.org_id AND s.brand_id = ANY(lc.brand_ids)
        WHERE l.human_id = s.human_id
           OR l.human_id IN (SELECT o.atomic_human_id FROM org_human_aliases o WHERE o.org_id = s.org_id AND o.human_id = s.human_id))
      AND NOT EXISTS (
        SELECT 1 FROM unnest(s.emails) AS e
        JOIN lead_contact_methods cm ON cm.channel = 'email' AND lower(cm.value) = lower(trim(e))
        JOIN leads_campaigns lc ON lc.lead_id = cm.lead_id AND lc.org_id = s.org_id AND s.brand_id = ANY(lc.brand_ids))
      AND (${after?.at ?? null}::timestamptz IS NULL OR (s.first_seen_at, s.human_id) > (${after?.at ?? null}::timestamptz, ${after?.human ?? null}::uuid))
    ORDER BY s.first_seen_at ASC, s.human_id
    LIMIT ${CANDIDATE_LIMIT}
  `)) as unknown as Candidate[];
}

async function fileCandidates(candidates: Candidate[], result: UniboxIntakeResult): Promise<void> {
  result.candidates += candidates.length;
  const byBrand = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = `${c.org_id}|${c.brand_id}`;
    byBrand.set(k, [...(byBrand.get(k) ?? []), c]);
  }
  for (const group of byBrand.values()) {
    const { org_id: orgId, brand_id: brandId } = group[0];
    const relationships = await loadRelationships(orgId, brandId, group.map((c) => c.human_id));
    for (const c of group) {
      if (!relationships.get(c.human_id)?.policies.pure_prospect) {
        result.notProspect++;
        continue;
      }
      const email = [...c.emails].map((e) => e.trim()).filter((e) => e.length > 0).sort()[0];
      if (!email) continue;
      const filing = await fileBrandIntakePerson({
        orgId,
        brandId,
        email,
        fullName: c.name,
        at: toIsoTimestamp(c.first_seen_at),
        campaignId: uniboxIntakeCampaignId(brandId),
        source: UNIBOX_INTAKE_SOURCE,
      });
      if (filing.status === "ambiguous_lead") {
        result.ambiguous++;
        console.warn(`[lead-service] unibox intake: ${email} (brand ${brandId}) is held by several leads (${filing.leadIds.join(", ")}); not filed`);
        continue;
      }
      if (filing.status === "filed") result.filed++;
    }
  }
}
