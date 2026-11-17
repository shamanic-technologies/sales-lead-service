/**
 * Every conversion the brand STATES counts, whoever caused it (UNMATCHED-MEETINGS-1117; owner 2026-11-07: « enlève ce
 * putain de filtre », every conversion counted, one figure on the dashboard and on our homepage).
 *
 * The site tag's ingest (`matchConversion`) looks for the person among the leads WE served for the brand. A person the
 * brand met through its own channels (Legistai: 14 people booked a meeting through its scheduler, none of them ever
 * contacted by us) matches nobody, so the row stayed `unmatched`: no lead, no lead state, no Unit, and the meetings
 * counted 0 on the dashboard ledger and the homepage. Whether WE caused a conversion is the whose-win split
 * (`caused_by_outreach`: ours / not ours / no proof), never whether it exists.
 *
 * This sweep gives each such conversion its person, the way brand-signups.ts does for a CRM signup:
 *   - the person is the one the EVENT names by its own address (one email = one lead, the service's identity rule):
 *     the lead owning it, else a new lead, filed ONCE under the brand's own intake `conversions:<brandId>`
 *     (`served`, `status_reason = 'tracker_conversion'`, dated at the earliest such conversion);
 *   - every live `unmatched` / `needs_review` row of that (org, brand, address) is attributed to that lead
 *     (`match_method = 'email'`, deterministic). A held row's name-only candidate is kept in
 *     `review_candidate_lead_id`: a shared surname was never evidence (FAKE-OUTCOMES-1022), and whether the booker is
 *     the same human as that candidate is human-service's answer (the identity sweep resolves the new lead's human by
 *     its address; a human holding two leads at one company is recorded there), never decided here.
 * Nothing about WHOSE win moves here: the cause sweep (outcome-cause.ts) answers the row by the date rule against our
 * first touch of the lead at (org, brand); a person we never touched reads `null` (no proof), never ours.
 *
 * Not filed: an event naming no address (no person to file), a member of the org's own team (`team_member`, never a
 * lead), an address held by several leads (`ambiguous_lead`, logged, waits for the identity repair). A withdrawn row is
 * never touched. Everything downstream (lead states, the ledger's Units, counts, triggers) reads the attributed row with
 * no change.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { fileBrandIntakePerson, type BrandScope, type SignupFiling } from "./brand-signups.js";

export const CONVERSION_INTAKE_SOURCE = "tracker_conversion";
export const CONVERSION_INTAKE_INTERVAL_MS = 2 * 60_000;
const FIRST_SWEEP_DELAY_MS = 90_000;

/** The brand's own intake: the campaign id a person the brand's conversions name is filed under. */
export function conversionIntakeCampaignId(brandId: string): string {
  return `conversions:${brandId}`;
}

interface PendingPerson {
  org_id: string;
  brand_id: string;
  email: string;
  full_name: string | null;
  first_at: Date | string | null;
  ids: string[];
}

/** Every (org, brand, address) a live conversion names that no lead was attributed to yet. */
async function pendingPeople(scope: BrandScope | null): Promise<PendingPerson[]> {
  return (await db.execute(sql`
    SELECT ce.org_id, ce.brand_id, lower(trim(ce.email)) AS email,
      (array_agg(NULLIF(trim(concat_ws(' ', ce.first_name, ce.last_name)), '')
        ORDER BY (NULLIF(trim(concat_ws(' ', ce.first_name, ce.last_name)), '') IS NULL), ce.received_at DESC NULLS LAST))[1] AS full_name,
      min(ce.received_at) AS first_at,
      array_agg(ce.id::text ORDER BY ce.id) AS ids
    FROM conversion_events ce
    WHERE ce.withdrawn_at IS NULL
      AND ce.attribution_status IN ('unmatched', 'needs_review')
      AND ce.email IS NOT NULL AND trim(ce.email) <> ''
      AND (${scope?.orgId ?? null}::text IS NULL OR (ce.org_id = ${scope?.orgId ?? null} AND ce.brand_id = ${scope?.brandId ?? null}))
    GROUP BY ce.org_id, ce.brand_id, lower(trim(ce.email))
    ORDER BY min(ce.received_at) ASC NULLS LAST, lower(trim(ce.email))
  `)) as unknown as PendingPerson[];
}

/** Attribute the rows to the lead; only rows still unattributed and live move (a concurrent statement wins). */
async function attributeRows(ids: string[], leadId: string): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE conversion_events SET
      review_candidate_lead_id = CASE WHEN attribution_status = 'needs_review' THEN matched_lead_id ELSE review_candidate_lead_id END,
      matched_lead_id = ${leadId}::uuid,
      match_method = 'email',
      match_confidence = 'deterministic',
      attribution_status = 'attributed',
      candidate_count = 1,
      attributed_by_intake_at = now()
    WHERE id = ANY(${sql.param(ids)}::uuid[])
      AND withdrawn_at IS NULL
      AND attribution_status IN ('unmatched', 'needs_review')
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return rows.length;
}

export interface ConversionIntakeResult {
  pending: number;
  filed: number;
  attributedRows: number;
  ambiguous: number;
  teamMembers: number;
}

/** File every person a live conversion names and attribute their conversions (of one brand when scoped). */
export async function runConversionIntake(scope: BrandScope | null = null): Promise<ConversionIntakeResult> {
  const pending = await pendingPeople(scope);
  const result: ConversionIntakeResult = { pending: pending.length, filed: 0, attributedRows: 0, ambiguous: 0, teamMembers: 0 };
  for (const p of pending) {
    const filing: SignupFiling = await fileBrandIntakePerson({
      orgId: p.org_id,
      brandId: p.brand_id,
      email: p.email,
      fullName: p.full_name,
      at: p.first_at === null ? null : new Date(p.first_at).toISOString(),
      campaignId: conversionIntakeCampaignId(p.brand_id),
      source: CONVERSION_INTAKE_SOURCE,
    });
    if (filing.status === "ambiguous_lead") {
      result.ambiguous++;
      console.warn(
        `[lead-service] conversion intake: an address of brand ${p.brand_id} is held by several leads ` +
          `(${filing.leadIds.join(", ")}); ${p.ids.length} conversion(s) wait for the identity repair`,
      );
      continue;
    }
    if (filing.status === "team_member") {
      result.teamMembers++;
      continue;
    }
    if (filing.status === "filed") result.filed++;
    result.attributedRows += await attributeRows(p.ids, filing.leadId);
  }
  return result;
}

let sweeping = false;

export function startConversionIntakeWorker(): void {
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const r = await runConversionIntake();
      if (r.attributedRows > 0 || r.ambiguous > 0) {
        console.log(
          `[lead-service] conversion intake: pending=${r.pending} filed=${r.filed} attributedRows=${r.attributedRows} ` +
            `ambiguous=${r.ambiguous} teamMembers=${r.teamMembers}`,
        );
      }
    } catch (error) {
      console.error("[lead-service] conversion intake sweep failed:", error);
    } finally {
      sweeping = false;
    }
  };
  setTimeout(() => void tick(), FIRST_SWEEP_DELAY_MS).unref();
  setInterval(() => void tick(), CONVERSION_INTAKE_INTERVAL_MS).unref();
}
