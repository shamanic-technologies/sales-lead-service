/**
 * Every person who SIGNED UP to a brand's product is a lead of that brand (owner 2026-10-13).
 *
 * Before this, a person reached a brand's leads only when a campaign served or named them, so a
 * brand's own signups were mostly not its leads: distribute.you held 2 tracker + 2 CRM signups among
 * dozens of orgs, and a client that signed up (ObraCam) could not be marked disqualified, tagged or
 * found under the brand at all.
 *
 * GENERIC, never a per-brand path: the brand's own CRM says who signed up. crm-service states every
 * signup it mirrors (Clerk, PostHog, any source) as a `signup` fact on its people fact feed, which is
 * copied verbatim into bronze `crm_facts` (crm-fact-feed.ts). Any brand whose CRM states signups gets
 * them as leads, distribute.you included. Synthetic or system identities and anonymous orgs never
 * claimed never sign up through a CRM source, so they never reach this (no rule here re-judges that).
 *
 * What it writes is what a campaign filing writes (named-person.ts), so every read sees the person
 * with no consumer change:
 *   - the lead, EMAIL-FIRST: the lead owning the address (case-folded), else a new lead (name from
 *     the fact) whose address is registered through `registerServedEmail`;
 *   - ONE `leads_campaigns` row, `served`, `status_reason = 'crm_signup'`, `served_at` = the earliest
 *     signup the CRM dates, under the brand's own intake `signups:<brandId>`: no campaign of
 *     campaign-service found them, the brand did. Its standing therefore reads `unresolved` /
 *     `campaign_unknown` (no leg), while every person-keyed fact (steps, Disqualified, timeline)
 *     reads as it does for any lead.
 * Only for a person who is NOT already a lead of the brand: a person a campaign already works keeps
 * that row as their lead (the brand list's one-row-per-person winner is unchanged).
 *
 * The Signup FACT itself is not written here: the CRM evidence sync pairs the CRM contact with this
 * lead on the email (deterministic) and writes the `signup` outcome it already writes for every
 * paired lead (crm-evidence-sync.ts). The brand's evidence pass is asked right after a filing, so the
 * fact lands within minutes. Idempotent on the row (`idx_lc_lead_campaign`); nothing deleted: a
 * withdrawn signup fact leaves the lead as it is (a correction about a fact, not about the person).
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { leads } from "../db/schema.js";
import { registerServedEmail } from "./leads-registry.js";
import { normalizeEmail, splitFullName } from "./named-person.js";

export const BRAND_SIGNUPS_SOURCE = "crm_signup";
export const BRAND_SIGNUPS_INTERVAL_MS = 2 * 60_000;
const FIRST_SWEEP_DELAY_MS = 75_000;

/** The brand's own intake: the campaign id a signup is filed under. */
export function brandSignupsCampaignId(brandId: string): string {
  return `signups:${brandId}`;
}

export interface BrandScope {
  orgId: string;
  brandId: string;
}

interface PendingSignup {
  org_id: string;
  brand_id: string;
  email: string;
  full_name: string | null;
  signed_up_at: Date | string | null;
}

/**
 * Every (org, brand, email) a live CRM `signup` fact names and that is not a lead of the brand yet.
 * One statement over the bronze copy; a fact a later `withdrawn` fact names is not live.
 */
async function pendingSignups(scope: BrandScope | null): Promise<PendingSignup[]> {
  return (await db.execute(sql`
    WITH signups AS (
      SELECT f.org_id, f.brand_id, lower(trim(e)) AS email, f.full_name, f.occurred_at, f.seq
      FROM crm_facts f, unnest(f.emails) AS e
      WHERE f.type = 'signup'
        AND (${scope?.orgId ?? null}::text IS NULL OR (f.org_id = ${scope?.orgId ?? null} AND f.brand_id = ${scope?.brandId ?? null}))
        AND trim(e) <> ''
        AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id)
    )
    SELECT s.org_id, s.brand_id, s.email,
      (array_agg(s.full_name ORDER BY (s.full_name IS NULL), s.seq DESC))[1] AS full_name,
      min(s.occurred_at) AS signed_up_at
    FROM signups s
    WHERE NOT EXISTS (
      SELECT 1 FROM leads_campaigns lc
      JOIN lead_contact_methods cm ON cm.lead_id = lc.lead_id AND cm.channel = 'email'
      WHERE lc.org_id = s.org_id AND s.brand_id = ANY(lc.brand_ids) AND lower(cm.value) = s.email
    )
    GROUP BY s.org_id, s.brand_id, s.email
    ORDER BY min(s.occurred_at) ASC NULLS LAST, s.email
  `)) as unknown as PendingSignup[];
}

async function leadsOwningEmail(email: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT lead_id::text AS lead_id FROM lead_contact_methods
    WHERE channel = 'email' AND lower(value) = ${email}
    ORDER BY lead_id
  `)) as unknown as Array<{ lead_id: string }>;
  return rows.map((r) => r.lead_id);
}

export type SignupFiling =
  | { status: "filed" | "already_filed"; leadId: string; leadCampaignId: string }
  | { status: "ambiguous_lead"; leadIds: string[] };

/** File ONE signup as a lead of the brand. */
export async function fileSignup(p: {
  orgId: string;
  brandId: string;
  email: string;
  fullName: string | null;
  signedUpAt: string | null;
}): Promise<SignupFiling> {
  return fileBrandIntakePerson({
    orgId: p.orgId,
    brandId: p.brandId,
    email: p.email,
    fullName: p.fullName,
    at: p.signedUpAt,
    campaignId: brandSignupsCampaignId(p.brandId),
    source: BRAND_SIGNUPS_SOURCE,
  });
}

/**
 * File ONE person the brand itself knows (a signup, a Unibox conversation) as a lead of the brand under one of its own
 * intakes (`campaignId`, never a campaign-service campaign): email-first lead, ONE `served` row dated `at`.
 */
export async function fileBrandIntakePerson(p: {
  orgId: string;
  brandId: string;
  email: string;
  fullName: string | null;
  at: string | null;
  campaignId: string;
  source: string;
}): Promise<SignupFiling> {
  const email = normalizeEmail(p.email);
  const owners = await leadsOwningEmail(email);
  if (owners.length > 1) return { status: "ambiguous_lead", leadIds: owners };

  let leadId: string;
  if (owners.length === 1) {
    leadId = owners[0];
  } else {
    const names = splitFullName(p.fullName);
    const [inserted] = await db
      .insert(leads)
      .values({ name: names.name, firstName: names.firstName, lastName: names.lastName })
      .returning({ id: leads.id });
    // A concurrent filing may have registered the address first: the owner wins (email-first).
    leadId = await registerServedEmail({ leadId: inserted.id, email, status: null, source: p.source });
  }

  const campaignId = p.campaignId;
  const created = (await db.execute(sql`
    INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, status_reason, served_at)
    VALUES (${leadId}, ${campaignId}, ${p.orgId}, ${sql.param([p.brandId])}::text[], 'served', ${p.source},
      COALESCE(${p.at}::timestamptz, now()))
    ON CONFLICT (lead_id, campaign_id) DO NOTHING
    RETURNING id::text AS id
  `)) as unknown as Array<{ id: string }>;
  if (created.length > 0) return { status: "filed", leadId, leadCampaignId: created[0].id };
  const existing = (await db.execute(sql`
    SELECT id::text AS id FROM leads_campaigns WHERE lead_id = ${leadId} AND campaign_id = ${campaignId} LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  if (existing.length === 0) {
    throw new Error(`[lead-service] brand intake: no leads_campaigns row after insert lead=${leadId} campaign=${campaignId}`);
  }
  return { status: "already_filed", leadId, leadCampaignId: existing[0].id };
}

export interface SignupSweepResult {
  pending: number;
  filed: number;
  ambiguous: number;
  /** The brands a lead was filed for: their CRM evidence pass is asked next. */
  brands: Array<{ orgId: string; brandId: string }>;
}

/** File every signup that is not a lead of its brand yet (of one brand when scoped). */
export async function fileBrandSignups(scope: BrandScope | null = null): Promise<SignupSweepResult> {
  const pending = await pendingSignups(scope);
  let filed = 0;
  let ambiguous = 0;
  const brands = new Map<string, { orgId: string; brandId: string }>();
  for (const s of pending) {
    const result = await fileSignup({
      orgId: s.org_id,
      brandId: s.brand_id,
      email: s.email,
      fullName: s.full_name,
      signedUpAt: s.signed_up_at === null ? null : new Date(s.signed_up_at).toISOString(),
    });
    if (result.status === "ambiguous_lead") {
      ambiguous++;
      console.warn(
        `[lead-service] brand signups: ${s.email} (brand ${s.brand_id}) is held by several leads ` +
          `(${result.leadIds.join(", ")}); not filed until the identity is repaired`,
      );
      continue;
    }
    if (result.status === "filed") filed++;
    brands.set(`${s.org_id}|${s.brand_id}`, { orgId: s.org_id, brandId: s.brand_id });
  }
  return { pending: pending.length, filed, ambiguous, brands: [...brands.values()] };
}

let sweeping = false;

/**
 * Every tick: file the pending signups, then ask each touched brand's CRM evidence pass, so the
 * Signup fact lands on the new lead within minutes rather than at the next 10-minute pass.
 */
export function startBrandSignupsWorker(
  afterFiling: (brand: { orgId: string; brandId: string }) => Promise<unknown>,
): void {
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      const r = await fileBrandSignups();
      if (r.filed > 0 || r.ambiguous > 0) {
        console.log(`[lead-service] brand signups: pending=${r.pending} filed=${r.filed} ambiguous=${r.ambiguous}`);
      }
      for (const brand of r.brands) {
        await afterFiling(brand).catch((error: unknown) =>
          console.error(
            `[lead-service] brand signups: CRM evidence pass for brand ${brand.brandId} failed, the Signup ` +
              `fact waits for the next pass: ${(error as Error).message}`,
          ),
        );
      }
    } catch (error) {
      console.error("[lead-service] brand signups sweep failed:", error);
    } finally {
      sweeping = false;
    }
  };
  setTimeout(() => void tick(), FIRST_SWEEP_DELAY_MS).unref();
  setInterval(() => void tick(), BRAND_SIGNUPS_INTERVAL_MS).unref();
}
