/**
 * Reflect what a brand's own CRM evidences onto the leads it is PAIRED with — one brand, one pass.
 *
 * Reads, in order: crm-service's dated funnel events (the contacts carrying any), the frozen pairing
 * for each of those contacts (matching any not matched yet, with the SAME matcher the pairings view
 * uses), the frozen judgments and the human rulings — and decides each pairing with the SAME policy
 * (`resolveCrmPairing`). Only `paired` counts — confident or `toConfirm` alike (doubt leans to us).
 *
 * Before any of that, the pass JUDGES EVERY CANDIDATE (`judgeEveryCandidate`): it walks their whole
 * contact list, matches whatever was never matched, and buys the same-person judgment for every
 * pairing that still waits on one — so no candidate stays undecided because nobody opened the
 * pairings page. There is no org request behind a pass, so the judgment goes through chat-service's
 * platform twin, which declares the spend. A judgment the vendor could not produce is not a verdict:
 * the pairing stays unconfirmed and is asked again on the next pass.
 *
 * Then, per paired lead: the earliest evidence per step, the whose-win rule against our first
 * delivered email (email-gateway, brand scope), a person's override if any, and the write into the
 * stores every read already reads (crm-evidence-store.ts). Evidence that no longer holds is set
 * aside at the END, after every read has answered — so a crm-service or email-gateway failure
 * throws before anything is set aside, and a brand is never emptied because a sibling was down.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  fetchCrmFunnelEvents,
  fetchCrmOpportunitiesByContact,
  streamCrmContacts,
  type CrmContact,
  type CrmIdentityContext,
} from "./crm-client.js";
import { loadFrozenMatches, loadJudgments, loadRulings, rulingKey, type FrozenMatch } from "./crm-pairing-store.js";
import { resolveCrmPairing } from "./crm-pairing.js";
import { matchesForContacts } from "./crm-matching.js";
import { awaitsJudgment, judgeCandidates } from "./crm-judging.js";
import { fetchPairedLeadFacts } from "./crm-pairing-view.js";
import { judgeSamePersonAsPlatform } from "./judgment-client.js";
import {
  CRM_POSITIVE_REPLY_STEP,
  formSubmissionsFrom,
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
import { flattenBrandStatus } from "./delivery-flatten.js";

/**
 * How many judgments one pass may buy. A judgment is bought once per pairing and then frozen, so
 * this bounds a brand's FIRST pass (and a CRM import of thousands of look-alikes), not steady
 * state; whatever it defers is judged on the next pass, one interval later.
 */
export const MAX_JUDGMENTS_PER_PASS = 500;

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
 * Walk their whole contact list and judge every pairing that still waits on a judgment.
 * Bounded memory (a page at a time) and bounded spend (`MAX_JUDGMENTS_PER_PASS`).
 */
export async function judgeEveryCandidate(
  orgId: string,
  brandId: string,
  ctx: CrmIdentityContext,
): Promise<CrmJudgingResult> {
  const out: CrmJudgingResult = { contacts: 0, judged: 0, judgmentFailed: 0, deferred: 0, withoutLead: 0 };
  const budget = { remaining: MAX_JUDGMENTS_PER_PASS };
  for await (const page of streamCrmContacts(brandId, ctx)) {
    out.contacts += page.length;
    const matches = await matchesForContacts(orgId, brandId, page);
    const ids = page.map((c) => c.id);
    const [judgments, rulings] = await Promise.all([
      loadJudgments(brandId, ids),
      loadRulings(brandId, ids),
    ]);
    const waiting = page.filter((c) => awaitsJudgment(c, matches, judgments, rulings));
    if (waiting.length === 0) continue;
    const leadFacts = await fetchPairedLeadFacts(
      brandId,
      Array.from(new Set(waiting.map((c) => matches.get(c.id)!.matchedLeadId!))),
    );
    const r = await judgeCandidates({
      orgId,
      brandId,
      contacts: waiting,
      matches,
      judgments,
      rulings,
      leadFacts,
      budget,
      judge: judgeSamePersonAsPlatform,
      logPrefix: "[crm-evidence]",
    });
    out.judged += r.judged;
    out.judgmentFailed += r.failures.size;
    out.deferred += r.deferred;
    out.withoutLead += r.withoutLead;
  }
  return out;
}

export interface CrmEvidenceSyncResult {
  brandId: string;
  judging: CrmJudgingResult;
  contactsWithEvents: number;
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

/** Their won deal's value, in cents, read off the opportunity the sale evidence names. */
function saleValueCents(
  evidence: CrmStepEvidence,
  opportunities: Map<string, { externalId: string | null; monetaryValue: number | null }[]>,
  crmContactId: string,
): number | null {
  if (evidence.step !== "sale" || !evidence.sourceId) return null;
  const opp = (opportunities.get(crmContactId) ?? []).find((o) => o.externalId === evidence.sourceId);
  const value = opp?.monetaryValue ?? null;
  return value !== null && value > 0 ? Math.round(value * 100) : null;
}

export async function syncCrmEvidence(orgId: string, brandId: string): Promise<CrmEvidenceSyncResult> {
  const ctx: CrmIdentityContext = { orgId, brandId };

  const judging = await judgeEveryCandidate(orgId, brandId, ctx);

  const contacts = (await fetchCrmFunnelEvents(brandId, ctx)).filter((c) => c.events.length > 0);
  const contactIds = contacts.map((c) => c.contactId);

  // The frozen pairing for each contact with evidence; match (and freeze) any never matched yet,
  // with the matcher the pairings view uses, off their full contact record.
  const matches = await loadFrozenMatches(brandId, contactIds);
  const missing = new Set(contactIds.filter((id) => !matches.has(id)));
  if (missing.size > 0) {
    const toMatch: CrmContact[] = [];
    for await (const page of streamCrmContacts(brandId, ctx)) {
      for (const contact of page) if (missing.has(contact.id)) toMatch.push(contact);
    }
    const matched = await matchesForContacts(orgId, brandId, toMatch);
    for (const [id, m] of matched) matches.set(id, m);
  }

  const [judgments, rulings] = await Promise.all([
    loadJudgments(brandId, contactIds),
    loadRulings(brandId, contactIds),
  ]);

  // Per paired lead, the earliest evidence per (kind, step) across every contact paired with them.
  const byLead = new Map<string, Map<string, LeadEvidence>>();
  const formsByLead = new Map<string, LeadForms>();
  let pairedContacts = 0;
  for (const contact of contacts) {
    const match = matches.get(contact.contactId);
    if (!match?.matchedLeadId) continue;
    const stored = judgments.get(contact.contactId) ?? null;
    const verdict = resolveCrmPairing({
      signal: match,
      judgment:
        stored && stored.leadId === match.matchedLeadId
          ? {
              samePersonProbability: stored.samePersonProbability,
              model: stored.model,
              judgedAt: stored.judgedAt,
            }
          : null,
      judgmentUnavailableReason: null,
      ruling: rulings.get(rulingKey(contact.contactId, match.matchedLeadId)) ?? null,
    });
    if (verdict.state !== "paired") continue;
    pairedContacts += 1;

    const leadId = match.matchedLeadId;
    const steps = byLead.get(leadId) ?? new Map<string, LeadEvidence>();
    const submissions = formSubmissionsFrom(contact.events);
    if (submissions.length > 0) {
      const forms = formsByLead.get(leadId) ?? [];
      forms.push({ crmContactId: contact.contactId, match, crmEmail: contact.primaryEmail, submissions });
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

  const needsValue = leadIds.some((id) => byLead.get(id)!.has("outcome:sale"));
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
        reply = { evidence: chosen, crmContactId: form.crmContactId, match: form.match, crmEmail: form.crmEmail };
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
        valueCents: saleValueCents(item.evidence, opportunities, item.crmContactId),
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
    pairedContacts,
    leads: leadIds.length,
    outcomes,
    nevers,
    withdrawnOutcomes,
    withdrawnNevers,
  };
}

/** Every (org, brand) whose CRM has ever been paired against our leads. */
export async function listCrmBrands(): Promise<Array<{ orgId: string; brandId: string }>> {
  const rows = (await db.execute(sql`
    SELECT DISTINCT org_id, brand_id FROM crm_pairing_matches
  `)) as unknown as Array<{ org_id: string; brand_id: string }>;
  return rows.map((r) => ({ orgId: r.org_id, brandId: r.brand_id }));
}
