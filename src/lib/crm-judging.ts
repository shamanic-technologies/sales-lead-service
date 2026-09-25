/**
 * Buying the same-person judgment for the CRM pairings that need one — shared by the pairings view
 * (org-billed, the reader's own identity) and the evidence sync (platform-billed, no org request
 * behind it), so a candidate is judged the same way whichever of them reaches it first.
 *
 * Who needs one is decided by the policy (`needsJudgment`): only a pairing the deterministic
 * signals could not decide, that nobody has ruled on, that carries no frozen judgment for THIS lead
 * yet, and whose lead we can describe. A judgment is frozen as soon as it is bought, so it is never
 * bought twice; a failure is returned as a typed reason and asked again on the next pass.
 */
import { needsJudgment, type CrmJudgmentUnavailableReason, type CrmPairingRuling } from "./crm-pairing.js";
import { rulingKey, saveJudgment, type FrozenMatch } from "./crm-pairing-store.js";
import { mapWithConcurrency } from "./crm-matching.js";
import {
  JudgmentUnavailableError,
  type SamePersonJudgment,
  type SamePersonSides,
} from "./judgment-client.js";
import type { CrmContact } from "./crm-client.js";
import type { PairedLeadFacts } from "./crm-pairing-view.js";

/** Judgments in flight at once. Bounded so one pass cannot stampede chat-service. */
export const JUDGMENT_CONCURRENCY = 6;

export type StoredJudgment = {
  leadId: string;
  samePersonProbability: number;
  model: string;
  judgedAt: string;
};

export interface JudgeCandidatesInput {
  orgId: string;
  brandId: string;
  contacts: CrmContact[];
  matches: Map<string, FrozenMatch>;
  /** Mutated: every judgment bought here is added, so the caller decides off it immediately. */
  judgments: Map<string, StoredJudgment>;
  rulings: Map<string, CrmPairingRuling>;
  leadFacts: Map<string, PairedLeadFacts>;
  /** Shared across calls of one pass; decremented by what this call spends. */
  budget: { remaining: number };
  judge: (sides: SamePersonSides) => Promise<SamePersonJudgment>;
  logPrefix: string;
}

/** Whether this contact's pairing still waits on a judgment. */
export function awaitsJudgment(
  contact: CrmContact,
  matches: Map<string, FrozenMatch>,
  judgments: Map<string, StoredJudgment>,
  rulings: Map<string, CrmPairingRuling>,
): boolean {
  const match = matches.get(contact.id);
  if (!match?.matchedLeadId) return false;
  if (!needsJudgment(match)) return false;
  // A judgment frozen against a DIFFERENT lead says nothing about this pairing.
  if (judgments.get(contact.id)?.leadId === match.matchedLeadId) return false;
  if (rulings.has(rulingKey(contact.id, match.matchedLeadId))) return false;
  return true;
}

export function sidesFor(contact: CrmContact, lead: PairedLeadFacts): SamePersonSides {
  return {
    crmContact: {
      fullName: contact.fullName,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.primaryEmail,
      phone: contact.phoneE164,
      company: contact.companyName ?? null,
    },
    ourLead: {
      fullName: lead.fullName,
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      jobTitle: lead.jobTitle,
      company: lead.company,
      companyDomain: lead.companyDomain,
      location: lead.location,
    },
  };
}

export interface JudgeCandidatesResult {
  judged: number;
  failures: Map<string, CrmJudgmentUnavailableReason>;
  /** Candidates this call could not reach because the pass's budget ran out. */
  deferred: number;
  /** Candidates whose lead we hold no row for in this brand — nothing to compare against. */
  withoutLead: number;
}

export async function judgeCandidates(input: JudgeCandidatesInput): Promise<JudgeCandidatesResult> {
  const { orgId, brandId, contacts, matches, judgments, rulings, leadFacts, budget } = input;
  const failures = new Map<string, CrmJudgmentUnavailableReason>();

  const waiting = contacts.filter((c) => awaitsJudgment(c, matches, judgments, rulings));
  const withLead = waiting.filter((c) => leadFacts.has(matches.get(c.id)!.matchedLeadId!));
  const withoutLead = waiting.length - withLead.length;
  const toJudge = withLead.slice(0, Math.max(0, budget.remaining));
  const deferred = withLead.length - toJudge.length;
  budget.remaining -= toJudge.length;

  let judged = 0;
  await mapWithConcurrency(toJudge, JUDGMENT_CONCURRENCY, async (contact) => {
    const match = matches.get(contact.id)!;
    const lead = leadFacts.get(match.matchedLeadId!)!;
    try {
      const judgment = await input.judge(sidesFor(contact, lead));
      await saveJudgment({
        orgId,
        brandId,
        crmContactId: contact.id,
        leadId: lead.leadId,
        samePersonProbability: judgment.probability,
        model: judgment.model,
      });
      judgments.set(contact.id, {
        leadId: lead.leadId,
        samePersonProbability: judgment.probability,
        model: judgment.model,
        judgedAt: new Date().toISOString(),
      });
      judged += 1;
    } catch (error) {
      if (!(error instanceof JudgmentUnavailableError)) throw error;
      console.warn(
        `${input.logPrefix} no judgment for contact="${contact.id}" lead="${lead.leadId}", so the ` +
          `pairing stays unconfirmed until the next attempt: ${error.message}`,
      );
      failures.set(contact.id, error.reason);
    }
  });

  return { judged, failures, deferred, withoutLead };
}
