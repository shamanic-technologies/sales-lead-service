/**
 * Reflect what a brand's own CRM evidences onto the leads it is PAIRED with — one brand, one pass.
 *
 * Reads, in order: crm-service's dated funnel events (the contacts carrying any), WHO each contact is
 * per human-service (the `humanId` crm-service states on its facts: `pairByHuman`), and the human
 * rulings, and decides each pairing with the SAME policy (`resolveCrmPairing`). "Same human?" is
 * human-service's answer only (owner 2026-10-13, LEAD-REFONTE-1013): the matcher this pass used to run
 * and the "same person?" judgments it bought were retired once the pairings needing them measured 0
 * in prod (2026-10-13); their frozen rows stay as records, read by nobody.
 *
 * Then, per paired lead: the earliest evidence per step, the whose-win rule against our first
 * delivered email (email-gateway, brand scope), a person's override if any, and the write into the
 * stores every read already reads (crm-evidence-store.ts). Evidence that no longer holds is set
 * aside at the END, after every read has answered — so a crm-service or email-gateway failure
 * throws before anything is set aside, and a brand is never emptied because a sibling was down.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { fetchCrmOpportunitiesByContact, type CrmIdentityContext } from "./crm-client.js";
import { loadRulings, rulingKey, type FrozenMatch } from "./crm-pairing-store.js";
import type { CrmContactFunnelEvents } from "./crm-fact-events.js";
import { pairingCarriesEvidence, resolveCrmPairing } from "./crm-pairing.js";
import {
  CRM_PAYMENT_EVENT,
  CRM_POSITIVE_REPLY_STEP,
  formSubmissionsFrom,
  paidValueCents,
  positiveReplyEvidence,
  crmCauseRule,
  crmOutcomeSignature,
  effectiveCrmCause,
  evidenceFromEvents,
  mergeEvidence,
  type CrmStepEvidence,
  type StoredCrmEvidence,
} from "./crm-evidence.js";
import {
  loadCauseStatements,
  loadLeadCampaignRows,
  loadNonCrmOutcomeKeys,
  upsertCrmNever,
  upsertCrmOutcome,
  withdrawStaleCrmNevers,
  withdrawStaleCrmOutcomes,
} from "./crm-evidence-store.js";
import { checkDeliveryStatus } from "./email-gateway-client.js";
import { loadCrmFunnelEvents } from "./crm-fact-events.js";
import { flattenBrandStatus } from "./delivery-flatten.js";

export interface CrmJudgingResult {
  /** Contacts walked. */
  contacts: number;
  /** Judgments bought this pass. */
  judged: number;
  /** Judgments the vendor could not produce — asked again next pass, never a verdict. */
  judgmentFailed: number;
  /** Candidates left for the next pass because this pass's budget ran out. */
  deferred: number;
  /** Candidates whose lead holds no row in this brand, so there is nothing to compare against. */
  withoutLead: number;
}

/**
 * "Same human?" is human-service's answer (owner 2026-10-13, LEAD-REFONTE-1013): a CRM contact whose
 * facts carry a `humanId` (crm-service#125) IS the lead of the brand holding that human (directly, or
 * through a fleet merge alias). Several leads of one human at the brand (they changed company) = the
 * most recently created one, the person's current company. Deterministic: no matcher, no judgment. A
 * person's ruling on the pair still outranks it (resolveCrmPairing).
 */
export async function pairByHuman(
  orgId: string,
  brandId: string,
  contacts: readonly CrmContactFunnelEvents[],
): Promise<Map<string, FrozenMatch>> {
  const out = new Map<string, FrozenMatch>();
  const humans = [...new Set(contacts.map((c) => c.humanId).filter((h): h is string => Boolean(h)))];
  if (humans.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (h.hid) h.hid::text AS human_id, l.id::text AS lead_id
    FROM unnest(${sql.param(humans)}::uuid[]) AS h(hid)
    LEFT JOIN human_aliases a ON a.atomic_human_id = h.hid
    JOIN leads l ON l.human_id = COALESCE(a.human_id, h.hid)
    WHERE EXISTS (SELECT 1 FROM leads_campaigns lc WHERE lc.lead_id = l.id AND lc.org_id = ${orgId} AND ${brandId} = ANY(lc.brand_ids))
    ORDER BY h.hid, l.created_at DESC, l.id
  `)) as unknown as Array<{ human_id: string; lead_id: string }>;
  const leadOf = new Map(rows.map((r) => [r.human_id, r.lead_id]));
  for (const c of contacts) {
    const leadId = c.humanId ? leadOf.get(c.humanId) : undefined;
    if (!leadId) continue;
    out.set(c.contactId, {
      crmContactId: c.contactId,
      matchedLeadId: leadId,
      matchMethod: "human",
      matchConfidence: "deterministic",
      candidateCount: 1,
      matchedAt: null,
    });
  }
  return out;
}

export interface CrmEvidenceSyncResult {
  brandId: string;
  judging: CrmJudgingResult;
  contactsWithEvents: number;
  /** Frozen matches replaced this pass by a deterministic one (crm-pairing-store.ts). */
  upgradedMatches: number;
  /** Contacts with events paired by human-service's humanId (no matcher, no judgment). */
  pairedByHuman: number;
  /** Contacts with events that still needed the old matcher (no humanId, or no lead holds it yet). */
  neededMatcher: number;
  pairedContacts: number;
  leads: number;
  outcomes: number;
  nevers: number;
  withdrawnOutcomes: number;
  withdrawnNevers: number;
}

interface LeadEvidence {
  evidence: CrmStepEvidence;
  crmContactId: string;
  match: FrozenMatch;
  crmEmail: string | null;
  /** What this contact paid the customer, net (`paidValueCents`); the value of a payment-evidenced sale. */
  paidCents: number | null;
}

/** Every form submission of every contact paired with a lead, kept whole (see positiveReplyEvidence). */
type LeadForms = Array<Omit<LeadEvidence, "evidence"> & { submissions: CrmStepEvidence[] }>;

async function primaryEmails(leadIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (leadIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT DISTINCT ON (lead_id) lead_id, lower(value) AS email
    FROM lead_contact_methods
    WHERE lead_id = ANY(${sql.param(leadIds)}::uuid[]) AND channel = 'email'
    ORDER BY lead_id, created_at ASC NULLS LAST, value ASC
  `)) as unknown as Array<{ lead_id: string; email: string }>;
  for (const r of rows) out.set(r.lead_id, r.email);
  return out;
}

/**
 * The sale's value, in cents: what the person paid when a payment evidences it, else their won
 * deal's value read off the opportunity the sale evidence names.
 */
function saleValueCents(
  item: LeadEvidence,
  opportunities: Map<string, { externalId: string | null; monetaryValue: number | null }[]>,
): number | null {
  const evidence = item.evidence;
  if (evidence.step !== "sale") return null;
  if (evidence.crmStep === CRM_PAYMENT_EVENT) return item.paidCents;
  if (!evidence.sourceId) return null;
  const opp = (opportunities.get(item.crmContactId) ?? []).find((o) => o.externalId === evidence.sourceId);
  const value = opp?.monetaryValue ?? null;
  return value !== null && value > 0 ? Math.round(value * 100) : null;
}

export async function syncCrmEvidence(orgId: string, brandId: string): Promise<CrmEvidenceSyncResult> {
  const ctx: CrmIdentityContext = { orgId, brandId };

  // Off the bronze copy of crm-service's people fact feed (crm-fact-events.ts); throws, setting
  // nothing aside, while that copy is still filling.
  const contacts = (await loadCrmFunnelEvents(orgId, brandId)).filter((c) => c.events.length > 0);
  const contactIds = contacts.map((c) => c.contactId);

  // Who human-service says each contact IS is the ONLY pairing (pairByHuman): this service no longer
  // runs its own matcher nor buys a "same person?" judgment (retired 2026-10-13 once the pairings
  // needing it measured 0 in prod). A person's ruling on a pair still outranks it.
  const matches = await pairByHuman(orgId, brandId, contacts);
  const judging: CrmJudgingResult = { contacts: 0, judged: 0, judgmentFailed: 0, deferred: 0, withoutLead: 0 };
  const upgraded = 0;
  const rulings = await loadRulings(brandId, contactIds);

  // Per paired lead, the earliest evidence per (kind, step) across every contact paired with them.
  const byLead = new Map<string, Map<string, LeadEvidence>>();
  const formsByLead = new Map<string, LeadForms>();
  let pairedContacts = 0;
  for (const contact of contacts) {
    const match = matches.get(contact.contactId);
    if (!match?.matchedLeadId) continue;
    // A person who rejected this pair outranks human-service's answer.
    const verdict = resolveCrmPairing({
      signal: match,
      judgment: null,
      judgmentUnavailableReason: null,
      ruling: rulings.get(rulingKey(contact.contactId, match.matchedLeadId)) ?? null,
    });
    if (!pairingCarriesEvidence(match, verdict)) continue;
    pairedContacts += 1;

    const leadId = match.matchedLeadId;
    const paidCents = paidValueCents(contact.events);
    const steps = byLead.get(leadId) ?? new Map<string, LeadEvidence>();
    const submissions = formSubmissionsFrom(contact.events);
    if (submissions.length > 0) {
      const forms = formsByLead.get(leadId) ?? [];
      forms.push({ crmContactId: contact.contactId, match, crmEmail: contact.primaryEmail, paidCents, submissions });
      formsByLead.set(leadId, forms);
    }
    for (const evidence of evidenceFromEvents(contact.events)) {
      // Which form stands as a positive reply depends on our first delivery — chosen below.
      if (evidence.step === CRM_POSITIVE_REPLY_STEP) continue;
      const key = `${evidence.kind}:${evidence.step}`;
      const current = steps.get(key);
      const next: LeadEvidence = {
        evidence,
        crmContactId: contact.contactId,
        match,
        crmEmail: contact.primaryEmail,
        paidCents,
      };
      if (!current || mergeEvidence(current.evidence, evidence) === evidence) steps.set(key, next);
    }
    byLead.set(leadId, steps);
  }

  // Only a person who is one of OUR leads in this brand carries anything.
  const rowsByLead = await loadLeadCampaignRows(brandId, Array.from(byLead.keys()));
  const leadIds = Array.from(byLead.keys()).filter((id) => rowsByLead.has(id));

  const emails = await primaryEmails(leadIds);
  const firstDelivered = new Map<string, string | null>();
  const emailList = Array.from(new Set(emails.values()));
  if (emailList.length > 0) {
    const status = await checkDeliveryStatus(
      brandId,
      undefined,
      emailList.map((email) => ({ email })),
      { orgId, brandId },
    );
    const byEmail = new Map(status.results.map((r) => [r.email.toLowerCase(), r]));
    for (const [leadId, email] of emails) {
      const result = byEmail.get(email);
      firstDelivered.set(leadId, result ? flattenBrandStatus(result).firstDeliveredAt : null);
    }
  }

  const [nonCrm, causeStatements] = await Promise.all([
    loadNonCrmOutcomeKeys(brandId, leadIds),
    loadCauseStatements(brandId, leadIds),
  ]);

  // Only a sale their GoHighLevel pipeline evidences takes its value off an opportunity; a paid one
  // carries its own, so a brand with no pipeline never asks for one.
  const needsValue = leadIds.some((id) => byLead.get(id)!.get("outcome:sale")?.evidence.crmStep === "sale");
  const opportunities = needsValue
    ? await fetchCrmOpportunitiesByContact(brandId, ctx)
    : new Map<string, { externalId: string | null; monetaryValue: number | null }[]>();

  const keepSignatures: string[] = [];
  const keepNevers: string[] = [];
  let outcomes = 0;
  let nevers = 0;

  for (const leadId of leadIds) {
    const steps = byLead.get(leadId)!;
    const outcomeSteps = new Set<string>();

    // A form their prospect submitted is a positive reply FOR US only when it answered our
    // outreach: the earliest submission dated after our first delivered email. One filled before
    // we wrote, an undated one, or one to a person we never delivered to is not written — and one
    // written on an earlier pass is set aside with the rest of the stale evidence below.
    const firstDeliveredAt = firstDelivered.get(leadId) ?? null;
    let reply: LeadEvidence | null = null;
    for (const form of formsByLead.get(leadId) ?? []) {
      const chosen = positiveReplyEvidence(form.submissions, firstDeliveredAt);
      if (chosen && (!reply || mergeEvidence(reply.evidence, chosen) === chosen)) {
        reply = {
          evidence: chosen,
          crmContactId: form.crmContactId,
          match: form.match,
          crmEmail: form.crmEmail,
          paidCents: form.paidCents,
        };
      }
    }
    if (reply) steps.set(`outcome:${CRM_POSITIVE_REPLY_STEP}`, reply);

    for (const item of steps.values()) {
      if (item.evidence.kind !== "outcome") continue;
      const step = item.evidence.step;
      outcomeSteps.add(step);
      // A person's statement (or the tracker's report) of this step outranks the CRM, and the two
      // must not both count.
      if (nonCrm.has(`${leadId}:${step}`)) continue;

      const rule = crmCauseRule(item.evidence.occurredAt, firstDelivered.get(leadId) ?? null);
      const cause = effectiveCrmCause(rule, causeStatements.get(`${leadId}:${step}`) ?? null);
      // A person who said this reply was NOT ours outranks the date: it is not written.
      if (step === CRM_POSITIVE_REPLY_STEP && cause.causedByOutreach !== true) continue;
      const evidence: StoredCrmEvidence = {
        crmContactId: item.crmContactId,
        crmStep: item.evidence.crmStep,
        source: item.evidence.source,
        sourceId: item.evidence.sourceId,
        dateBasis: item.evidence.dateBasis,
        detail: item.evidence.detail,
        rule,
      };
      await upsertCrmOutcome({
        orgId,
        brandId,
        leadId,
        step,
        occurredAt: item.evidence.occurredAt,
        valueCents: saleValueCents(item, opportunities),
        causedByOutreach: cause.causedByOutreach,
        email: emails.get(leadId) ?? item.crmEmail,
        matchMethod: item.match.matchMethod,
        matchConfidence: item.match.matchConfidence,
        candidateCount: item.match.candidateCount,
        evidence,
      });
      keepSignatures.push(crmOutcomeSignature(leadId, step));
      outcomes += 1;
    }

    for (const item of steps.values()) {
      if (item.evidence.kind !== "never") continue;
      const step = item.evidence.step;
      // The step demonstrably happened (a later meeting was attended, a later deal won): the
      // "never" is contradicted, so it is not written at all.
      if (outcomeSteps.has(step) || nonCrm.has(`${leadId}:${step}`)) continue;
      const evidence: StoredCrmEvidence = {
        crmContactId: item.crmContactId,
        crmStep: item.evidence.crmStep,
        source: item.evidence.source,
        sourceId: item.evidence.sourceId,
        dateBasis: item.evidence.dateBasis,
        detail: item.evidence.detail,
      };
      for (const row of rowsByLead.get(leadId) ?? []) {
        const id = await upsertCrmNever({
          orgId,
          brandId,
          row,
          step,
          occurredAt: item.evidence.occurredAt,
          evidence,
        });
        if (id) {
          keepNevers.push(id);
          nevers += 1;
        }
      }
    }
  }

  const withdrawnOutcomes = await withdrawStaleCrmOutcomes(brandId, keepSignatures);
  const withdrawnNevers = await withdrawStaleCrmNevers(brandId, keepNevers);

  return {
    brandId,
    judging,
    contactsWithEvents: contacts.length,
    upgradedMatches: upgraded,
    pairedByHuman: matches.size,
    neededMatcher: 0,
    pairedContacts,
    leads: leadIds.length,
    outcomes,
    nevers,
    withdrawnOutcomes,
    withdrawnNevers,
  };
}

/**
 * Every (org, brand) the pass runs for: every brand any of whose tools ever told the platform about
 * a person (a fact on the copy of crm-service's people feed), plus every brand already paired. NOT
 * only brands somebody once opened the pairings page for: a brand enters the pass the moment its
 * first fact lands, whichever tool it came from.
 */
export async function listCrmBrands(): Promise<Array<{ orgId: string; brandId: string }>> {
  const rows = (await db.execute(sql`
    SELECT org_id, brand_id FROM crm_facts GROUP BY org_id, brand_id
    UNION
    SELECT org_id, brand_id FROM crm_pairing_matches GROUP BY org_id, brand_id
  `)) as unknown as Array<{ org_id: string; brand_id: string }>;
  return rows.map((r) => ({ orgId: r.org_id, brandId: r.brand_id }));
}
