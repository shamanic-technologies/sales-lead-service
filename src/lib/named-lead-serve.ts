/**
 * A serve that NAMES its person (LEAD-NAMED-SERVE-1015, owner 2026-10-15: a trigger-headed funnel runs the SAME pipe
 * and workflows as a proactive campaign). A trigger occurrence names a person (a ⚡ Lead a client fires through
 * campaign-service's door, or lead-service's own `lead_found`); campaign-service files them on the campaign
 * (`POST /orgs/campaigns/{id}/leads/by-email`, named-person.ts) and starts the cold workflow, whose serve states
 * `namedLead: { leadId, triggerEventId }`. That serve hands out EXACTLY that person as this campaign's lead, in the
 * served shape every serve returns (pullNext builds it), or says by name why it cannot. Never another person.
 *
 * Checks, in order (first refusal wins):
 *   1. the person holds a row on THIS campaign of the org (`named_lead_not_filed`, final);
 *   2. a registered email (`named_lead_no_email`, final: the sender's records are keyed on it);
 *   2b. not a journalist of the brand (`named_lead_journalist`, final; JOURNALISTS-NOT-LEADS-1016);
 *   3. not opted out / do-not-contact (the human's facts), not unsubscribed / hard-bounced (the sender's answer)
 *      (`named_lead_suppressed`, final);
 *   4. per OCCURRENCE (`named_lead_serves`): a redelivered run of an occurrence already handed out is refused once
 *      the sender holds MORE for this campaign than at the first hand-out (an email sent, or the person queued or
 *      newly contacted: `named_lead_already_worked`, final), and served again otherwise (the run failed before
 *      sending). The sender's word is read every time, never a local guess; unreadable = `named_lead_sender_unreadable`
 *      (wait).
 *   5. the sender refuses / is finished with the person on this campaign (`named_lead_sender_refuses`,
 *      `named_lead_sender_finished`, final); a NEW occurrence of a person still in this campaign's send queue is
 *      `named_lead_in_send_queue` (final: a hand-off would be a duplicate the sender drops);
 *   6. something to write a real email with: a first name or a current company. A person known only by an email is
 *      ENRICHED once (treg `people.enrich`, org-billed on the serve run, at the owner-approved ceiling), the result
 *      written like a sourced lead's (name only where empty; company + title as the current employment). Still
 *      nothing = `named_lead_unwritable` (final).
 * Credit refused (402 on the enrichment) and a serve that ran out of time stay today's waits (`credit_insufficient`,
 * `serve_timed_out`, `final: false`).
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkDeliveryStatus } from "./email-gateway-client.js";
import { fetchChannelSendsBatch, channelSendKey, type ChannelSend } from "./channel-send-client.js";
import { loadHumanFacts } from "./human-opt-out-read.js";
import { leadIsJournalist } from "./brand-journalists.js";
import { senderSuppression, type SuppressionReason } from "./named-person.js";
import { campaignScopeFlags, type CandidateStatusFlags, type PoolSender } from "./retry-pool.js";
import { recordEmploymentHistory } from "./leads-registry.js";
import type { Person } from "./people-client.js";
import { TregMeter, type SpendIdentity } from "./treg-client.js";
import { ENRICH_ENDPOINT, ENRICH_MAX_MICRO } from "./relationship-company.js";
import type { NamedLeadReason } from "./serve-reasons.js";

/** The body field: which person the run's occurrence names. */
export interface NamedLeadRequest {
  /** lead-service's lead id (campaign-service's `trigger.leadId`). */
  leadId: string;
  /** The trigger occurrence (campaign-service event id): a redelivered run carries the same one. */
  triggerEventId: string;
}

export interface NamedLeadRefusal {
  reason: NamedLeadReason;
  /** One sentence a client can read. */
  message: string;
  /** true = a retry cannot change it (end the occurrence as refused); false = wait and ask again. */
  final: boolean;
}

function refuse(reason: NamedLeadReason, message: string, final = true): NamedLeadRefusal {
  return { reason, message, final };
}

const SUPPRESSION_SENTENCE: Record<SuppressionReason, string> = {
  unsubscribed: "This person unsubscribed from your emails, so we will not email them.",
  bounced: "Emails to this address bounce, so we will not email this person.",
  opted_out: "This person asked not to be contacted, so we will not email them.",
  do_not_contact: "This person is marked do not contact, so we will not email them.",
};

/** What the sender held for the person on this campaign when an occurrence was first handed out. */
export interface OccurrenceBaseline {
  sentCount: number | null;
  contacted: boolean | null;
  firstServedAt: string;
}

/** The sender's count of emails sent to the person on this campaign: `sentCount`, else 1/0 from `sent`. */
export function sentCountOf(flags: CandidateStatusFlags & { sentCount?: number | null }): number {
  if (typeof flags.sentCount === "number") return flags.sentCount;
  return flags.sent ? 1 : 0;
}

/**
 * PURE. The email sender's answer for an occurrence. `baseline` null = a NEW occurrence (never handed out yet).
 * Returns a refusal, or null = hand the person out.
 */
export function decideEmailOccurrence(
  flags: (CandidateStatusFlags & { sentCount?: number | null }) | null,
  baseline: OccurrenceBaseline | null,
): NamedLeadRefusal | null {
  if (!flags) {
    return refuse("named_lead_sender_unreadable", "We could not check whether this person was already emailed. We will try again shortly.", false);
  }
  if (baseline) {
    const moreSent = baseline.sentCount !== null && sentCountOf(flags) > baseline.sentCount;
    const newlyContacted = baseline.contacted === false && flags.contacted;
    if (moreSent || flags.queued === true || newlyContacted) {
      return refuse("named_lead_already_worked", "This person was already emailed for this request.");
    }
  }
  if (flags.refusal) {
    const until = flags.refusal.until ? ` until ${flags.refusal.until.slice(0, 10)}` : "";
    return refuse(
      "named_lead_sender_refuses",
      `Our sender will not email this person${until} (${flags.refusal.code.replace(/_/g, " ")}).`,
    );
  }
  if (flags.finished === true) {
    return refuse("named_lead_sender_finished", "This campaign has already finished emailing this person.");
  }
  if (!baseline && flags.queued === true) {
    return refuse("named_lead_in_send_queue", "This person is already waiting to be emailed by this campaign.");
  }
  return null;
}

/**
 * PURE. A non-email sender's record (crm-service sends) for an occurrence: a send of THIS campaign dated at or after
 * the first hand-out = already worked; a new occurrence of a person with a send still in flight = in the queue.
 */
export function decideChannelOccurrence(
  sends: readonly ChannelSend[] | undefined,
  campaignId: string,
  baseline: OccurrenceBaseline | null,
): NamedLeadRefusal | null {
  const mine = (sends ?? []).filter((s) => s.campaignId === campaignId && (s.status === "sent" || s.status === "sending"));
  if (baseline) {
    const since = Date.parse(baseline.firstServedAt);
    const after = mine.some((s) => {
      const at = Date.parse(s.createdAt ?? s.sentAt ?? "");
      return Number.isNaN(at) || at >= since;
    });
    if (after) return refuse("named_lead_already_worked", "This person was already contacted for this request.");
    return null;
  }
  if (mine.some((s) => s.status === "sending")) {
    return refuse("named_lead_in_send_queue", "This person is already waiting to be contacted by this campaign.");
  }
  return null;
}

/** PURE. A real email can be written to a person we know by first name or by current company. */
export function isWritable(lead: { firstName: string | null; companyName: string | null }): boolean {
  return Boolean(lead.firstName?.trim()) || Boolean(lead.companyName?.trim());
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** PURE. What a treg `people.enrich` answer states about the person (its normalized `output`). */
export function readEnrichOutput(body: unknown): {
  found: boolean;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  title: string | null;
  companyName: string | null;
  companyDomain: string | null;
  linkedinUrl: string | null;
} {
  const out = (body as { output?: Record<string, unknown> } | null)?.output ?? null;
  const o = out && typeof out === "object" ? out : {};
  const fullName = str(o.full_name);
  let firstName = str(o.first_name);
  let lastName = str(o.last_name);
  if (!firstName && fullName) {
    const space = fullName.indexOf(" ");
    firstName = space < 0 ? fullName : fullName.slice(0, space);
    lastName = lastName ?? (space < 0 ? null : fullName.slice(space + 1));
  }
  const nested = o.company && typeof o.company === "object" ? (o.company as Record<string, unknown>) : null;
  const companyName = str(o.company_name) ?? (nested ? str(nested.name) : str(o.company));
  const rawDomain = str(o.company_domain) ?? (nested ? str(nested.domain) ?? str(nested.website) : null);
  const companyDomain = rawDomain
    ? rawDomain.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase() || null
    : null;
  const li = str(o.linkedin_url);
  const linkedinUrl = li ? (/^https?:\/\//i.test(li) ? li : `https://www.linkedin.com/in/${li.replace(/^\/+|\/+$/g, "")}`) : null;
  return {
    found: Boolean(fullName || firstName || companyName),
    firstName,
    lastName,
    fullName: fullName ?? ([firstName, lastName].filter(Boolean).join(" ") || null),
    title: str(o.title) ?? str(o.job_title),
    companyName,
    companyDomain,
    linkedinUrl,
  };
}

interface NamedRow {
  leadCampaignId: string;
  email: string | null;
  firstName: string | null;
  companyName: string | null;
}

async function loadNamedRow(orgId: string, campaignId: string, leadId: string): Promise<NamedRow | null> {
  const rows = (await db.execute(sql`
    SELECT lc.id::text AS lead_campaign_id,
      (SELECT cm.value FROM lead_contact_methods cm
        WHERE cm.lead_id = lc.lead_id AND cm.channel = 'email'
        ORDER BY cm.created_at, cm.id LIMIT 1) AS email,
      l.first_name,
      (SELECT o.name FROM leads_organizations lo JOIN organizations o ON o.id = lo.organization_id
        WHERE lo.lead_id = lc.lead_id AND lo.current = true AND o.name IS NOT NULL
        ORDER BY lo.created_at DESC LIMIT 1) AS company_name
    FROM leads_campaigns lc
    JOIN leads l ON l.id = lc.lead_id
    WHERE lc.org_id = ${orgId} AND lc.campaign_id = ${campaignId} AND lc.lead_id = ${leadId}::uuid
    LIMIT 1
  `)) as unknown as Array<{ lead_campaign_id: string; email: string | null; first_name: string | null; company_name: string | null }>;
  const r = rows[0];
  if (!r) return null;
  return { leadCampaignId: r.lead_campaign_id, email: r.email, firstName: r.first_name, companyName: r.company_name };
}

async function loadBaseline(campaignId: string, leadId: string, triggerEventId: string): Promise<OccurrenceBaseline | null> {
  const rows = (await db.execute(sql`
    SELECT baseline_sent_count, baseline_contacted, first_served_at::text AS first_served_at
    FROM named_lead_serves
    WHERE campaign_id = ${campaignId} AND lead_id = ${leadId}::uuid AND trigger_event_id = ${triggerEventId}
  `)) as unknown as Array<{ baseline_sent_count: number | null; baseline_contacted: boolean | null; first_served_at: string }>;
  const r = rows[0];
  if (!r) return null;
  return {
    sentCount: r.baseline_sent_count === null ? null : Number(r.baseline_sent_count),
    contacted: r.baseline_contacted,
    firstServedAt: new Date(r.first_served_at).toISOString(),
  };
}

/** Enrich a lead known only by an email, ONCE per lead ever, and write what was found like a sourced lead's. */
async function enrichOnce(params: { leadId: string; email: string; identity: SpendIdentity }): Promise<void> {
  const done = (await db.execute(sql`
    SELECT 1 FROM named_lead_enrichments WHERE lead_id = ${params.leadId}::uuid
  `)) as unknown as unknown[];
  if (done.length > 0) return;

  const result = await new TregMeter(params.identity).call({
    endpointId: ENRICH_ENDPOINT,
    method: "POST",
    params: { email: params.email },
    maxMicro: ENRICH_MAX_MICRO,
  });
  const enrich = result.status < 300 ? readEnrichOutput(result.body) : readEnrichOutput(null);
  const servedBy = (result.body as { _treg?: { served_by?: unknown } } | null)?._treg?.served_by;
  const output = (result.body as { output?: unknown } | null)?.output ?? null;
  await db.execute(sql`
    INSERT INTO named_lead_enrichments (lead_id, paid_by_org_id, run_id, found, charged_micro, served_by, output)
    VALUES (${params.leadId}::uuid, ${params.identity.orgId}, ${params.identity.runId}, ${enrich.found}, ${result.chargedMicro},
      ${typeof servedBy === "string" ? servedBy : null}, ${output === null ? null : JSON.stringify(output)}::jsonb)
    ON CONFLICT (lead_id) DO NOTHING
  `);
  if (!enrich.found) {
    console.log(`[lead-service] named serve: enrichment found nobody lead=${params.leadId} status=${result.status} charged=${result.chargedMicro}`);
    return;
  }

  // A name the brand or its CRM stated is kept: only empty fields take the provider's.
  await db.execute(sql`
    UPDATE leads SET
      first_name = COALESCE(first_name, ${enrich.firstName}),
      last_name = COALESCE(last_name, ${enrich.lastName}),
      name = COALESCE(name, ${enrich.fullName}),
      linkedin_url = COALESCE(linkedin_url, ${enrich.linkedinUrl}),
      enriched_at = now()
    WHERE id = ${params.leadId}::uuid
  `);
  if (enrich.companyName || enrich.companyDomain) {
    const hasCompany = (await db.execute(sql`
      SELECT 1 FROM leads_organizations WHERE lead_id = ${params.leadId}::uuid AND current = true LIMIT 1
    `)) as unknown as unknown[];
    if (hasCompany.length === 0) {
      const person = {
        firstName: enrich.firstName,
        lastName: enrich.lastName,
        name: enrich.fullName,
        title: enrich.title,
        email: params.email,
        organization: {
          name: enrich.companyName,
          domain: enrich.companyDomain,
          websiteUrl: null,
          industry: null,
          estimatedNumEmployees: null,
          annualRevenue: null,
          linkedinUrl: null,
          logoUrl: null,
          city: null,
          state: null,
          country: null,
        },
        employmentHistory: null,
      } as unknown as Person;
      await recordEmploymentHistory({ leadId: params.leadId, person });
    }
  }
}

export type NamedServeDecision =
  | { ok: true; email: string; leadCampaignId: string }
  | ({ ok: false } & NamedLeadRefusal);

/**
 * Decide whether the named person is handed out on this run, enriching them first when needed, and record the
 * hand-out of the occurrence. Throws on our own database failing, on a paid call failing, and on billing refusing
 * the enrichment (`InsufficientCreditError`, surfaced by the route as `credit_insufficient`).
 */
export async function prepareNamedServe(params: {
  orgId: string;
  brandId: string;
  campaignId: string;
  named: NamedLeadRequest;
  sender: PoolSender;
  runId: string | null;
  parentRunId: string | null;
  context: { userId?: string | null; workflowSlug?: string | null; featureSlug?: string | null };
}): Promise<NamedServeDecision> {
  const { orgId, brandId, campaignId, named } = params;
  const row = await loadNamedRow(orgId, campaignId, named.leadId);
  if (!row) {
    return { ok: false, ...refuse("named_lead_not_filed", "This person was not added to this campaign, so there is nobody to write to.") };
  }
  if (!row.email) {
    return { ok: false, ...refuse("named_lead_no_email", "We have no email address for this person, so this campaign cannot write to them.") };
  }
  const email = row.email.trim().toLowerCase();
  // A brand never sells to a journalist (JOURNALISTS-NOT-LEADS-1016, brand-journalists.ts).
  if (await leadIsJournalist(named.leadId, orgId, [brandId])) {
    return { ok: false, ...refuse("named_lead_journalist", "This person is a journalist you pitch for press coverage, so no sales campaign writes to them.") };
  }

  const human = (await loadHumanFacts([named.leadId])).get(named.leadId);
  if (human?.optedOut) return { ok: false, ...refuse("named_lead_suppressed", SUPPRESSION_SENTENCE.opted_out) };
  if (human?.doNotContact) return { ok: false, ...refuse("named_lead_suppressed", SUPPRESSION_SENTENCE.do_not_contact) };

  const baseline = await loadBaseline(campaignId, named.leadId, named.triggerEventId);
  const ctx: Record<string, string> = { orgId, campaignId, brandId };
  if (params.context.userId) ctx.userId = params.context.userId;
  if (params.runId) ctx.runId = params.runId;

  let flags: (CandidateStatusFlags & { sentCount?: number | null }) | null = null;
  let refusal: NamedLeadRefusal | null;
  try {
    const status = await checkDeliveryStatus(brandId, campaignId, [{ email }], ctx);
    const mine = status.results.find((r) => r.email.trim().toLowerCase() === email);
    const suppressed = senderSuppression(mine, campaignId);
    if (suppressed) return { ok: false, ...refuse("named_lead_suppressed", SUPPRESSION_SENTENCE[suppressed]) };
    if (params.sender === "email") {
      const scoped = campaignScopeFlags(mine, campaignId);
      const sentCount = mine?.broadcast?.campaign?.sentCount ?? mine?.broadcast?.byCampaign?.[campaignId]?.sentCount ?? null;
      flags = scoped ? { ...scoped, sentCount } : null;
      refusal = decideEmailOccurrence(flags, baseline);
    } else {
      const sends = await fetchChannelSendsBatch(brandId, campaignId, [email], { orgId, userId: params.context.userId, runId: params.runId });
      refusal = decideChannelOccurrence(sends.get(channelSendKey(email)), campaignId, baseline);
    }
  } catch (err) {
    console.error(`[lead-service] named serve: sender unreadable campaign=${campaignId} lead=${named.leadId}:`, err);
    refusal = refuse("named_lead_sender_unreadable", "We could not check whether this person was already contacted. We will try again shortly.", false);
  }
  if (refusal) {
    if (baseline) await noteRefusal(campaignId, named, refusal.reason);
    return { ok: false, ...refusal };
  }

  if (!isWritable(row)) {
    if (!params.runId) throw new Error("[lead-service] named serve: enriching a person needs the serve run (x-run-id)");
    await enrichOnce({
      leadId: named.leadId,
      email,
      identity: {
        orgId,
        userId: params.context.userId ?? null,
        runId: params.runId,
        brandId,
        campaignId,
        workflowSlug: params.context.workflowSlug ?? null,
        featureSlug: params.context.featureSlug ?? null,
      },
    });
    const after = await loadNamedRow(orgId, campaignId, named.leadId);
    if (!after || !isWritable(after)) {
      return {
        ok: false,
        ...refuse("named_lead_unwritable", "We only know this person's email address: no name or company was found, so we cannot write them a real email."),
      };
    }
  }

  // The hand-out of this occurrence: the baseline is what the sender held at the FIRST one.
  await db.execute(sql`
    INSERT INTO named_lead_serves
      (org_id, brand_id, campaign_id, lead_id, lead_campaign_id, trigger_event_id, last_run_id, baseline_sent_count, baseline_contacted)
    VALUES
      (${orgId}, ${brandId}, ${campaignId}, ${named.leadId}::uuid, ${row.leadCampaignId}::uuid, ${named.triggerEventId}, ${params.runId},
       ${flags ? sentCountOf(flags) : null}, ${flags ? flags.contacted : null})
    ON CONFLICT (campaign_id, lead_id, trigger_event_id) DO UPDATE SET
      serve_count = named_lead_serves.serve_count + 1,
      last_served_at = now(),
      last_run_id = excluded.last_run_id,
      refused_code = NULL,
      refused_at = NULL
  `);
  // The run that will now contact the person (as a retry claim re-points them): `served_at` untouched.
  // Recorded with its workflow (migration 0096, WORKFLOW-SEND-HISTORY-1016): this run's workflow sends, not the serving one.
  await db.execute(sql`
    WITH repointed AS (
      UPDATE leads_campaigns
         SET run_id = ${params.runId}, push_run_id = ${params.runId}, parent_run_id = ${params.parentRunId}, updated_at = now()
       WHERE id = ${row.leadCampaignId}::uuid
      RETURNING id
    )
    INSERT INTO lead_campaign_run_repoints (lead_campaign_id, run_id, workflow_slug, repointed_at, cause)
    SELECT id, ${params.runId}, ${params.context.workflowSlug ?? null}, now(), 'named_serve' FROM repointed
  `);
  return { ok: true, email, leadCampaignId: row.leadCampaignId };
}

async function noteRefusal(campaignId: string, named: NamedLeadRequest, code: NamedLeadReason): Promise<void> {
  await db.execute(sql`
    UPDATE named_lead_serves SET refused_code = ${code}, refused_at = now()
    WHERE campaign_id = ${campaignId} AND lead_id = ${named.leadId}::uuid AND trigger_event_id = ${named.triggerEventId}
  `);
}
