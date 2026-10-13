/**
 * A campaign that NAMES its people: "the person with this email, already known to the brand, is
 * now a lead of the brand on this campaign". No purchase, no human-service serve.
 *
 * Owner 2026-10-11: "100% des personnes qui parlent au chat devraient être des leads". A person who
 * signed up to a brand's product (or that the brand otherwise already talks to) is known to its CRM,
 * not bought from a provider, so the serve path (human-service audiences, billing, suppression,
 * never-cold-contact) is the wrong door: nothing is bought and nobody is cold. The caller is
 * campaign-service, the moment a campaign that names its people is born (any campaign may: the
 * Copilot's one-person follow-up is the first, never a Copilot-only branch).
 *
 * What it writes is EXACTLY what a serve writes, so every read (lists, standing, timeline, CRM
 * pairing, follow-up queue) sees the person with no consumer change:
 *   - the lead, identity EMAIL-FIRST (the lead owning the address, case-folded; else a new lead whose
 *     address is registered through `registerServedEmail`, never an email-less lead);
 *   - one `leads_campaigns` row, `status = 'served'`, `served_at` = now, brand = the campaign's own
 *     brand (read from campaign-service, never accepted from the caller).
 *
 * KNOWN TO THE BRAND is positive evidence, never a guess: a live (never withdrawn) fact of the
 * brand's CRM copy (`crm_facts`, any type, any source: a signup, a message, a payment) carrying the
 * address at (org, brand), or a lead row of the org already filed under the brand. Anything else is
 * a named refusal: this door files people the brand knows, it never sources strangers.
 *
 * OR STATED BY THE BRAND (PUSHED-PERSON-KNOWN-1014, owner 2026-10-14): a person the brand's OWN
 * organization names to us is positive evidence the brand knows them. The caller carries the statement
 * (`statedBy`: campaign-service, filing the person a trigger occurrence of the org names by identity,
 * e.g. a client pushing an email it wrote with its own key). The statement is recorded
 * (`brand_person_statements`, append-only) and the person is known to the brand from then on, for every
 * later filing. Any trigger, any channel: nothing here reads which trigger it was. A stated person goes
 * through the suppression a serve applies BEFORE anything is written: an address the brand's sender
 * reports unsubscribed or hard-bounced (email-gateway, brand/campaign/global), or a human with a live
 * opt_out / do_not_contact fact, is refused by name (`person_suppressed` + reason). The follow-up claim
 * re-checks opt-outs at send time as for anyone.
 *
 * Idempotent on (lead, campaign): the unique index `idx_lc_lead_campaign` makes a second filing
 * answer the same row (`already_filed`), never a second one.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { leads } from "../db/schema.js";
import { fetchCampaign } from "./campaign-client.js";
import { checkDeliveryStatus, type StatusResult } from "./email-gateway-client.js";
import { loadHumanFacts } from "./human-opt-out-read.js";
import { registerServedEmail } from "./leads-registry.js";

export const NAMED_PERSON_SOURCE = "named_person";

/** The brand's own organization named this person to us: the evidence the brand knows them. */
export interface PersonStatement {
  /** The trigger occurrence that named the person (campaign-service's event id). */
  triggerEventId: string;
  /** The trigger type it was an occurrence of: provenance only, never read for a decision. */
  triggerId?: string | null;
}

/** How the brand is known to know the person. */
export type KnownBy = "crm_fact" | "brand_lead" | "statement";

/** Why a stated person is not filed: a protection a serve applies. */
export type SuppressionReason = "unsubscribed" | "bounced" | "opted_out" | "do_not_contact";

export interface NamedPersonFiling {
  status: "filed" | "already_filed";
  leadId: string;
  leadCampaignId: string;
  campaignId: string;
  brandId: string;
  email: string;
  servedAt: string;
  knownBy: KnownBy;
}

export type NamedPersonResult =
  | ({ ok: true } & NamedPersonFiling)
  | { ok: false; code: "campaign_not_found" }
  | { ok: false; code: "campaign_has_no_brand" }
  | { ok: false; code: "person_not_known" }
  | { ok: false; code: "person_suppressed"; reason: SuppressionReason }
  | { ok: false; code: "ambiguous_lead"; leadIds: string[] };

/** The brand a campaign row is about: its `brandId`, else the first of the legacy `brandIds`. */
export function campaignBrandOf(campaign: { brandId?: unknown; brandIds?: unknown }): string | null {
  if (typeof campaign.brandId === "string" && campaign.brandId.trim()) return campaign.brandId;
  if (Array.isArray(campaign.brandIds)) {
    const first = campaign.brandIds.find((b): b is string => typeof b === "string" && b.trim().length > 0);
    if (first) return first;
  }
  return null;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** "Jane van Dyke" -> first "Jane", last "van Dyke". A single word is a first name. */
export function splitFullName(fullName: string | null): { name: string | null; firstName: string | null; lastName: string | null } {
  const name = fullName?.trim().replace(/\s+/g, " ") || null;
  if (!name) return { name: null, firstName: null, lastName: null };
  const space = name.indexOf(" ");
  if (space < 0) return { name, firstName: name, lastName: null };
  return { name, firstName: name.slice(0, space), lastName: name.slice(space + 1) };
}

interface KnownPerson {
  known: boolean;
  knownBy: KnownBy | null;
  fullName: string | null;
}

/** Is the address known to the brand? A live CRM fact of (org, brand) or a lead row of the brand. */
async function knownToBrand(orgId: string, brandId: string, email: string): Promise<KnownPerson> {
  const facts = (await db.execute(sql`
    SELECT f.full_name
    FROM crm_facts f
    WHERE f.org_id = ${orgId}
      AND f.brand_id = ${brandId}
      AND f.type <> 'withdrawn'
      AND EXISTS (SELECT 1 FROM unnest(f.emails) AS e WHERE lower(trim(e)) = ${email})
      AND NOT EXISTS (
        SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id
      )
    ORDER BY (f.full_name IS NULL), f.seq DESC
    LIMIT 1
  `)) as unknown as Array<{ full_name: string | null }>;
  if (facts.length > 0) return { known: true, knownBy: "crm_fact", fullName: facts[0].full_name };

  const rows = (await db.execute(sql`
    SELECT 1
    FROM leads_campaigns lc
    JOIN lead_contact_methods cm ON cm.lead_id = lc.lead_id AND cm.channel = 'email'
    WHERE lc.org_id = ${orgId}
      AND ${brandId} = ANY(lc.brand_ids)
      AND lower(cm.value) = ${email}
    LIMIT 1
  `)) as unknown as unknown[];
  if (rows.length > 0) return { known: true, knownBy: "brand_lead", fullName: null };

  const stated = (await db.execute(sql`
    SELECT full_name FROM brand_person_statements
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND email = ${email}
    ORDER BY (full_name IS NULL), stated_at DESC
    LIMIT 1
  `)) as unknown as Array<{ full_name: string | null }>;
  if (stated.length > 0) return { known: true, knownBy: "statement", fullName: stated[0].full_name };
  return { known: false, knownBy: null, fullName: null };
}

/**
 * What the brand's sender says about the address: unsubscribed (global, brand, this campaign) or
 * hard-bounced fleet-wide. Pure.
 */
export function senderSuppression(result: StatusResult | undefined, campaignId: string): SuppressionReason | null {
  if (!result) return null;
  let bounced = false;
  for (const provider of [result.broadcast, result.transactional]) {
    if (!provider) continue;
    if (provider.global?.email?.unsubscribed) return "unsubscribed";
    for (const scope of [provider.campaign, provider.brand, provider.byCampaign?.[campaignId]]) {
      if (scope?.unsubscribed) return "unsubscribed";
    }
    if (provider.global?.email?.bounced) bounced = true;
  }
  return bounced ? "bounced" : null;
}

/**
 * The suppression a serve applies, for a person the brand states: the human's live opt_out /
 * do_not_contact fact (when a lead already owns the address), then the sender's answer. THROWS when
 * email-gateway cannot answer: a stated person is never filed on a guess about who opted out.
 */
async function suppressionOf(params: {
  orgId: string;
  brandId: string;
  campaignId: string;
  email: string;
  ownerLeadIds: string[];
  userId?: string | null;
  runId?: string | null;
}): Promise<SuppressionReason | null> {
  if (params.ownerLeadIds.length > 0) {
    const facts = await loadHumanFacts(params.ownerLeadIds);
    for (const id of params.ownerLeadIds) {
      const human = facts.get(id);
      if (human?.optedOut) return "opted_out";
      if (human?.doNotContact) return "do_not_contact";
    }
  }
  const context: Record<string, string> = { orgId: params.orgId, campaignId: params.campaignId, brandId: params.brandId };
  if (params.userId) context.userId = params.userId;
  if (params.runId) context.runId = params.runId;
  const status = await checkDeliveryStatus(params.brandId, params.campaignId, [{ email: params.email }], context);
  const mine = status.results.find((r) => r.email.trim().toLowerCase() === params.email);
  return senderSuppression(mine, params.campaignId);
}

/** Record the brand's statement. Idempotent on (org, brand, address, source, ref). */
async function recordStatement(params: {
  orgId: string;
  brandId: string;
  campaignId: string;
  email: string;
  statement: PersonStatement;
  fullName: string | null;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO brand_person_statements
      (org_id, brand_id, email, source, source_ref, trigger_id, campaign_id, full_name)
    VALUES
      (${params.orgId}, ${params.brandId}, ${params.email}, 'trigger_event', ${params.statement.triggerEventId},
       ${params.statement.triggerId ?? null}, ${params.campaignId}, ${params.fullName})
    ON CONFLICT (org_id, brand_id, email, source, source_ref) DO NOTHING
  `);
}

/** The lead owning the address, case-folded. Several = a broken identity, refused by name. */
async function leadsOwningEmail(email: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT lead_id FROM lead_contact_methods
    WHERE channel = 'email' AND lower(value) = ${email}
    ORDER BY lead_id
  `)) as unknown as Array<{ lead_id: string }>;
  return rows.map((r) => r.lead_id);
}

export async function fileNamedPerson(params: {
  orgId: string;
  campaignId: string;
  email: string;
  userId?: string | null;
  runId?: string | null;
  /** The brand's own organization names this person (see the module comment). */
  statedBy?: PersonStatement | null;
  /** The name the statement carries, used only for a lead created here with no CRM name. */
  fullName?: string | null;
}): Promise<NamedPersonResult> {
  const email = normalizeEmail(params.email);

  // Throws on campaign-service 5xx/unreachable: the route answers 502, never a guessed brand.
  const campaign = await fetchCampaign(params.campaignId, params.orgId, {
    userId: params.userId,
    runId: params.runId,
  });
  if (!campaign) return { ok: false, code: "campaign_not_found" };
  const row = campaign as unknown as {
    brandId?: unknown;
    brandIds?: unknown;
    featureSlug?: unknown;
    workflowSlug?: unknown;
  };
  const brandId = campaignBrandOf(row);
  if (!brandId) return { ok: false, code: "campaign_has_no_brand" };

  let person = await knownToBrand(params.orgId, brandId, email);
  if (!person.known && !params.statedBy) return { ok: false, code: "person_not_known" };

  const owners = await leadsOwningEmail(email);
  if (owners.length > 1) return { ok: false, code: "ambiguous_lead", leadIds: owners };

  if (params.statedBy) {
    const suppressed = await suppressionOf({
      orgId: params.orgId,
      brandId,
      campaignId: params.campaignId,
      email,
      ownerLeadIds: owners,
      userId: params.userId,
      runId: params.runId,
    });
    if (suppressed) return { ok: false, code: "person_suppressed", reason: suppressed };
    const statedName = params.fullName?.trim() || null;
    await recordStatement({
      orgId: params.orgId,
      brandId,
      campaignId: params.campaignId,
      email,
      statement: params.statedBy,
      fullName: statedName,
    });
    if (!person.known) person = { known: true, knownBy: "statement", fullName: statedName };
  }

  let leadId: string;
  if (owners.length === 1) {
    leadId = owners[0];
  } else {
    const names = splitFullName(person.fullName);
    const [inserted] = await db
      .insert(leads)
      .values({ name: names.name, firstName: names.firstName, lastName: names.lastName })
      .returning({ id: leads.id });
    // A concurrent filing may have registered the address first: the owner wins (email-first).
    leadId = await registerServedEmail({
      leadId: inserted.id,
      email,
      status: null,
      source: NAMED_PERSON_SOURCE,
    });
  }

  const featureSlug = typeof row.featureSlug === "string" ? row.featureSlug : null;
  const workflowSlug = typeof row.workflowSlug === "string" ? row.workflowSlug : null;
  const created = (await db.execute(sql`
    INSERT INTO leads_campaigns
      (lead_id, campaign_id, org_id, brand_ids, status, served_at, run_id, user_id, feature_slug, workflow_slug)
    VALUES
      (${leadId}, ${params.campaignId}, ${params.orgId}, ${sql.param([brandId])}::text[], 'served', now(),
       ${params.runId ?? null}, ${params.userId ?? null}, ${featureSlug}, ${workflowSlug})
    ON CONFLICT (lead_id, campaign_id) DO NOTHING
    RETURNING id, served_at::text AS served_at
  `)) as unknown as Array<{ id: string; served_at: string }>;

  const filed = created.length > 0;
  const existing = filed
    ? created
    : ((await db.execute(sql`
        SELECT id, COALESCE(served_at, created_at)::text AS served_at FROM leads_campaigns
        WHERE lead_id = ${leadId} AND campaign_id = ${params.campaignId}
        LIMIT 1
      `)) as unknown as Array<{ id: string; served_at: string }>);
  if (existing.length === 0) {
    throw new Error(
      `[lead-service] named person: no leads_campaigns row after insert lead=${leadId} campaign=${params.campaignId}`,
    );
  }

  return {
    ok: true,
    status: filed ? "filed" : "already_filed",
    leadId,
    leadCampaignId: existing[0].id,
    campaignId: params.campaignId,
    brandId,
    email,
    servedAt: new Date(existing[0].served_at).toISOString(),
    knownBy: person.knownBy as KnownBy,
  };
}
