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
import { isGatewayEmail } from "./email-gateway-client.js";

export const UNIBOX_INTAKE_SOURCE = "unibox_conversation";
/** A Unibox lead a verdict later said is not the brand's: filed out (`skipped`), kept as a record (LEADS-JUDGE-BRAND-1021). */
export const NOT_BRAND_LEAD_REASON = "not_brand_lead";
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
  /** Members of the org (its team, org-members.ts): never filed. */
  teamMembers: number;
  /** Pure prospects not filed because none of their addresses is one email-gateway accepts. */
  malformed: number;
}

/** File every Unibox pure prospect that is not a lead of its brand yet (of one brand when scoped). */
export async function fileUniboxLeads(scope: { orgId: string; brandId: string } | null = null): Promise<UniboxIntakeResult> {
  const result: UniboxIntakeResult = { candidates: 0, filed: 0, notProspect: 0, ambiguous: 0, teamMembers: 0, malformed: 0 };
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
        WHERE l.human_id = s.human_id)
      AND (${after?.at ?? null}::timestamptz IS NULL OR (s.first_seen_at, s.human_id) > (${after?.at ?? null}::timestamptz, ${after?.human ?? null}::uuid))
    ORDER BY s.first_seen_at ASC, s.human_id
    LIMIT ${CANDIDATE_LIMIT}
  `)) as unknown as Candidate[];
}

/**
 * The candidates already a lead of their brand through an aliased human or one of their addresses: asked in two
 * batched, indexed statements per brand (as NOT EXISTS per subject the planner scanned every address: 120 s timeout).
 */
async function alreadyLeads(orgId: string, brandId: string, group: Candidate[]): Promise<Set<string>> {
  const emails = [...new Set(group.flatMap((c) => c.emails.map((e) => e.trim().toLowerCase())).filter((e) => e.length > 0))];
  const [byAlias, byEmail] = await Promise.all([
    db.execute(sql`
      SELECT DISTINCT o.human_id::text AS human_id FROM org_human_aliases o
      JOIN leads l ON l.human_id = o.atomic_human_id
      JOIN leads_campaigns lc ON lc.lead_id = l.id AND lc.org_id = ${orgId} AND ${brandId} = ANY(lc.brand_ids)
      WHERE o.org_id = ${orgId} AND o.human_id = ANY(${sql.param(group.map((c) => c.human_id))}::uuid[])
    `) as unknown as Promise<Array<{ human_id: string }>>,
    emails.length === 0
      ? Promise.resolve([] as Array<{ email: string }>)
      : (db.execute(sql`
          SELECT DISTINCT lower(cm.value) AS email FROM lead_contact_methods cm
          JOIN leads_campaigns lc ON lc.lead_id = cm.lead_id AND lc.org_id = ${orgId} AND ${brandId} = ANY(lc.brand_ids)
          WHERE cm.channel = 'email' AND lower(cm.value) = ANY(${sql.param(emails)}::text[])
        `) as unknown as Promise<Array<{ email: string }>>),
  ]);
  const aliased = new Set(byAlias.map((r) => r.human_id));
  const held = new Set(byEmail.map((r) => r.email));
  return new Set(group.filter((c) => aliased.has(c.human_id) || c.emails.some((e) => held.has(e.trim().toLowerCase()))).map((c) => c.human_id));
}

async function fileCandidates(candidates: Candidate[], result: UniboxIntakeResult): Promise<void> {
  const byBrand = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const k = `${c.org_id}|${c.brand_id}`;
    byBrand.set(k, [...(byBrand.get(k) ?? []), c]);
  }
  for (const all of byBrand.values()) {
    const { org_id: orgId, brand_id: brandId } = all[0];
    const known = await alreadyLeads(orgId, brandId, all);
    const group = all.filter((c) => !known.has(c.human_id));
    result.candidates += group.length;
    if (group.length === 0) continue;
    const relationships = await loadRelationships(orgId, brandId, group.map((c) => c.human_id));
    for (const c of group) {
      if (!relationships.get(c.human_id)?.policies.pure_prospect) {
        result.notProspect++;
        continue;
      }
      // Only an address email-gateway accepts can be filed: a lead is served to be emailed, and one
      // malformed address in a delivery-status batch makes the gateway refuse the whole batch
      // (LEAD-CHANGES-INVALID-EMAIL-1016: two customer.io unsubscribe addresses, `...====@unsubscribe2.customer.io`).
      const addresses = [...c.emails].map((e) => e.trim()).filter((e) => e.length > 0).sort();
      const email = addresses.find(isGatewayEmail);
      if (!email) {
        if (addresses.length > 0) {
          result.malformed++;
          console.error(
            `[lead-service] unibox intake: subject ${c.human_id} (brand ${brandId}) has no address email-gateway accepts ` +
              `(${addresses.map((e) => JSON.stringify(e)).join(", ")}); not filed`,
          );
        }
        continue;
      }
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
      if (filing.status === "team_member") {
        result.teamMembers++;
        continue;
      }
      if (filing.status === "filed") result.filed++;
    }
  }
}

export interface UniboxReconcileResult {
  filedOut: number;
  filedBack: number;
}

/**
 * A person filed from the Unibox STAYS a lead only while no verdict says they are not the brand's (LEADS-JUDGE-BRAND-1021,
 * owner 2026-10-21: "a person stops being a lead of the brand when the judge, or crm-service's verdict on their
 * conversation, says they are not the brand's lead"). Prod 2026-10-16: four of Doc Dinners' prospects filed as
 * distribute.you leads stayed leads after crm-service read their threads as another business, and were emailed.
 * The intake row is filed out (`status = 'skipped'`, `status_reason = 'not_brand_lead'`, never deleted: the serve and
 * every send stay on record) and filed back the day the verdict turns (`relationship-tags.ts` `notBrandLeadOf`). The
 * follow-up verdict refuses them anyway (`not_brand_lead`); this keeps the brand's lead list saying the same.
 */
export async function reconcileUniboxLeads(scope: { orgId: string; brandId: string } | null = null): Promise<UniboxReconcileResult> {
  const out: UniboxReconcileResult = { filedOut: 0, filedBack: 0 };
  const rows = (await db.execute(sql`
    SELECT lc.id::text AS id, lc.org_id, lc.brand_ids[1] AS brand_id, lc.status, l.human_id::text AS human_id
    FROM leads_campaigns lc JOIN leads l ON l.id = lc.lead_id
    WHERE lc.campaign_id LIKE 'unibox:%' AND l.human_id IS NOT NULL
      AND ((lc.status = 'served' AND lc.status_reason = ${UNIBOX_INTAKE_SOURCE}) OR (lc.status = 'skipped' AND lc.status_reason = ${NOT_BRAND_LEAD_REASON}))
      AND (${scope?.orgId ?? null}::text IS NULL OR (lc.org_id = ${scope?.orgId ?? null} AND lc.campaign_id = ${scope ? uniboxIntakeCampaignId(scope.brandId) : null}))
  `)) as unknown as Array<{ id: string; org_id: string; brand_id: string; status: string; human_id: string }>;
  const byBrand = new Map<string, typeof rows>();
  for (const r of rows) byBrand.set(`${r.org_id}|${r.brand_id}`, [...(byBrand.get(`${r.org_id}|${r.brand_id}`) ?? []), r]);
  for (const group of byBrand.values()) {
    const { org_id: orgId, brand_id: brandId } = group[0];
    const blocks = await loadRelationships(orgId, brandId, [...new Set(group.map((r) => r.human_id))]);
    const out_ = group.filter((r) => r.status === "served" && blocks.get(r.human_id)?.notBrandLead);
    const back = group.filter((r) => r.status === "skipped" && !blocks.get(r.human_id)?.notBrandLead);
    if (out_.length > 0) {
      for (const r of out_) {
        console.log(`[lead-service] unibox lead ${r.id} (human ${r.human_id}, brand ${brandId}) filed out: ${blocks.get(r.human_id)?.notBrandLead}`);
      }
      await db.execute(sql`
        UPDATE leads_campaigns SET status = 'skipped', status_reason = ${NOT_BRAND_LEAD_REASON},
          status_details = ${"A verdict says this person is not the brand's lead (LEADS-JUDGE-BRAND-1021)"}, updated_at = now()
        WHERE id = ANY(${sql.param(out_.map((r) => r.id))}::uuid[]) AND status = 'served' AND status_reason = ${UNIBOX_INTAKE_SOURCE}
      `);
      out.filedOut += out_.length;
    }
    if (back.length > 0) {
      await db.execute(sql`
        UPDATE leads_campaigns SET status = 'served', status_reason = ${UNIBOX_INTAKE_SOURCE}, status_details = NULL, updated_at = now()
        WHERE id = ANY(${sql.param(back.map((r) => r.id))}::uuid[]) AND status = 'skipped' AND status_reason = ${NOT_BRAND_LEAD_REASON}
      `);
      out.filedBack += back.length;
    }
  }
  return out;
}
