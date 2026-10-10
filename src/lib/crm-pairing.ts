/**
 * WHETHER A PERSON IN THE CUSTOMER'S OWN CRM IS SOMEBODY WE EMAILED — the policy, pure.
 *
 * A customer runs their own CRM and we mirror it (crm-service). Their CRM already knows things
 * about people we contacted that we do not: a deal closed on a call, a meeting that was attended,
 * a client who churned. None of it reaches us, because nothing ever pairs the two sides.
 *
 * Four things decide a pairing, and the order between them is the whole policy:
 *
 *   1. THE SIGNAL. The pairing is proposed by the SAME identity-resolution waterfall that
 *      attributes an inbound conversion event to a lead (`matchConversion`, conversions.ts). There
 *      is deliberately no second matcher here: two matchers would be two answers to one question,
 *      and the question — "is this row the same human as that row" — is the same question.
 *
 *   2. WHAT THAT SIGNAL IS WORTH IS *NOT* THE SAME HERE AS IT IS THERE. The attribution path
 *      attributes a name-only match to the top candidate, and that is correct where it lives: a
 *      real conversion arrived, somebody has to own it, and the alternative is losing it. Here
 *      nobody is claiming these people converted, so a name is not enough to merge two records.
 *      Measured on the first customer with a mirrored CRM: email pairs 14 people, first-and-last
 *      name pairs 19, and LAST NAME ALONE PAIRS 164 — "Jones", "Patel", "Cox". A policy that
 *      merged those would quietly tell a customer that 164 of their contacts are leads of ours.
 *      So `signalVerdict` never returns `paired` on a probabilistic tier, whatever the count.
 *
 *   3. WHERE THE DETERMINISTIC SIGNALS CANNOT DECIDE, A JUDGMENT DECIDES — not a string
 *      comparison. The judgment is a TYPED probability from the fleet's judgment vendor, reached
 *      through chat-service (which owns the model resolution, the credential and the cost
 *      declaration). It is recorded with the model release that produced it and NEVER re-asked on
 *      read, so the same pairing resolves the same way twice and the customer's table does not
 *      change under them between page loads. The evidence sync buys it for EVERY candidate, so no
 *      candidate stays undecided because nobody opened a page. A judgment the vendor could not
 *      produce leaves the pairing exactly where the signal left it — `unconfirmed` — says so, and
 *      is asked again on the next pass; it is never read as a merge and never as a rejection.
 *
 *      DOUBT LEANS TO US, AND STAYS VISIBLE (owner's rule). A confident yes pairs, a confident no
 *      rejects, and everything in between PAIRS too — the lead counts for the customer's ROI and
 *      the CRM's evidence flows onto it — but carries `toConfirm: true`, so a person can see which
 *      pairings rest on a hesitant model and confirm or deny them. A denial removes everything the
 *      pairing contributed on the next evidence pass.
 *
 *      A NAME IS ONLY EVER A HINT (owner, 2026-10-10). A pairing whose only signal is a name
 *      (first+last or last name alone: no shared email, phone or company domain) is never
 *      EVIDENCE until a person accepts it, however sure the model is: the judgment may pair it,
 *      but always `toConfirm`, and `pairingCarriesEvidence` keeps every CRM fact of that contact
 *      off the lead's replies, steps, conversions, sale and standing. A judgment is a model's
 *      reading of two names, and "Kimmy Johnson" filling a Meta Ads form is not "McKenzie
 *      Johnson" replying to our email (prod, 72 Johnsons, judged 0.21 and counted as a positive
 *      reply). Deterministic and company-domain signals are untouched.
 *
 *   4. A HUMAN OUTRANKS ALL OF IT. Somebody looking at the two rows can accept or deny the
 *      pairing, and their statement beats both the signal and the judgment. It is retractable and
 *      it never deletes (the same posture step statements already take), which is what makes a
 *      re-run of the matcher unable to resurrect something a person already rejected.
 *
 * Everything in this module is pure: no IO, no clock, no DB. The route gathers the four inputs
 * and this decides.
 */
import type { MatchConfidence, MatchMethod } from "./conversions.js";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Where a pairing stands. A PARTITION — every CRM contact is in exactly one of these, so the
 * counts sum to the number of contacts.
 *
 *   paired       — we say this CRM contact is this lead of ours
 *   unconfirmed  — a candidate exists and nothing strong enough has ruled on it yet
 *   rejected     — a human denied it, or a judgment landed below the floor
 *   unpaired     — the waterfall found nobody
 */
export const CRM_PAIRING_STATES = ["paired", "unconfirmed", "rejected", "unpaired"] as const;
export type CrmPairingState = (typeof CRM_PAIRING_STATES)[number];

/** Who decided. `null` on `unconfirmed` and `unpaired` — nobody has. */
export const CRM_PAIRING_DECIDERS = ["signal", "judgment", "human"] as const;
export type CrmPairingDecider = (typeof CRM_PAIRING_DECIDERS)[number];

/**
 * What happened to the similarity judgment for this pairing.
 *
 *   pair | reject | undecided — the vendor answered, and the probability landed above the bar,
 *                               below the floor, or between them
 *   not_needed                — a deterministic signal already decided; nothing was asked or spent
 *   not_asked                 — this read's judgment budget was spent before reaching this row
 *   unavailable               — we tried and could not get an answer. NOT a verdict.
 */
export const CRM_JUDGMENT_STATUSES = [
  "pair",
  "reject",
  "undecided",
  "not_needed",
  "not_asked",
  "unavailable",
] as const;
export type CrmJudgmentStatus = (typeof CRM_JUDGMENT_STATUSES)[number];

/**
 * Why no judgment could be had. Stated, never collapsed into "undecided": "we could not ask" and
 * "the model was unsure" are different facts about the same blank cell.
 */
export const CRM_JUDGMENT_UNAVAILABLE_REASONS = [
  "judgment_service_unavailable",
  "judgment_refused_request",
  "judgment_answer_unreadable",
  "no_run_id",
] as const;
export type CrmJudgmentUnavailableReason = (typeof CRM_JUDGMENT_UNAVAILABLE_REASONS)[number];

/**
 * A yes-probability at or above this pairs CONFIDENTLY; at or below the floor it rejects; between
 * them the model was hesitating, and the pairing is PAIRED BUT `toConfirm` — it counts for the
 * customer (owner: "when in doubt, lean toward us") and is listed for a person to confirm or deny.
 */
export const CRM_JUDGMENT_PAIR_AT = 0.85;
export const CRM_JUDGMENT_REJECT_AT = 0.15;

/**
 * The state of an opportunity on THEIR side. The one field of theirs that carries a fixed meaning.
 *
 * Their PIPELINE STAGE names do not: they are free text, chosen per customer — real examples on
 * the first mirrored account are "Free Trail Client", "Showed?", "BOOKED - NO BUY",
 * "Off Borading completed", "ACTIVE CLIENT - DWD + EMAIL + SEO". There is no canonical mapping
 * from those to any step vocabulary of ours, and inventing one produces a confident wrong answer,
 * so this module does not have one. See `CRM_STAGE_UNCOMPARABLE_REASON`.
 */
export const CRM_OPPORTUNITY_STATES = ["open", "won", "lost", "abandoned"] as const;
export type CrmOpportunityState = (typeof CRM_OPPORTUNITY_STATES)[number];

/**
 * Why a stage name is never compared to anything of ours. Served on every contact carrying an
 * opportunity so a consumer renders the reason rather than an empty column.
 */
export const CRM_STAGE_UNCOMPARABLE_REASON = "stage_names_are_free_text_per_customer" as const;

/**
 * Their state, or `null` when it is a word we do not recognise. Never guessed, never defaulted to
 * `open`: a state we cannot read is a fact about their data worth seeing, and this surface exists
 * partly to measure how often it happens.
 */
export function canonicalizeOpportunityState(raw: unknown): CrmOpportunityState | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (CRM_OPPORTUNITY_STATES as readonly string[]).includes(v)
    ? (v as CrmOpportunityState)
    : null;
}

// ---------------------------------------------------------------------------
// The four inputs
// ---------------------------------------------------------------------------

/** The waterfall's frozen output for one CRM contact. Exactly `MatchResult`, minus the half the conversion path owns. */
export interface CrmPairingSignal {
  matchedLeadId: string | null;
  matchMethod: MatchMethod;
  matchConfidence: MatchConfidence;
  candidateCount: number;
}

/** A frozen similarity judgment. Carries the release that produced it, never an alias. */
export interface CrmPairingJudgment {
  samePersonProbability: number;
  /** The model release the vendor reported serving, e.g. `jev-1.13.0`. */
  model: string;
  judgedAt: string;
}

export type CrmPairingRulingKind = "accepted" | "rejected";

/** A live (non-withdrawn) human statement about this exact pairing. */
export interface CrmPairingRuling {
  ruling: CrmPairingRulingKind;
  note: string | null;
  statedByUserId: string | null;
  statedAt: string;
}

export interface CrmPairingInput {
  signal: CrmPairingSignal;
  judgment: CrmPairingJudgment | null;
  /** Set when a judgment was attempted and could not be had. Mutually exclusive with `judgment`. */
  judgmentUnavailableReason: CrmJudgmentUnavailableReason | null;
  ruling: CrmPairingRuling | null;
}

export interface CrmPairingVerdict {
  state: CrmPairingState;
  decidedBy: CrmPairingDecider | null;
  /**
   * `true` on a pairing a judgment decided that a person should confirm: a HESITANT judgment
   * (probability strictly between the floor and the bar), or ANY judgment on a name-only signal
   * (whose facts do not count until a person accepts it, see `pairingCarriesEvidence`). `false` on
   * every other verdict — a confident judgment on a stronger signal, a deterministic signal, a
   * human ruling, or no pairing at all.
   */
  toConfirm: boolean;
  judgmentStatus: CrmJudgmentStatus;
  judgmentUnavailableReason: CrmJudgmentUnavailableReason | null;
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/**
 * What the signal ALONE is worth.
 *
 *   email / phone (deterministic)          → paired. A shared unique identifier.
 *   company domain + last name (strong):
 *       exactly one candidate              → paired
 *       several                            → unconfirmed (two people share a surname at one firm)
 *   first+last name, last name only        → NEVER paired. A name is not an identity.
 *   nothing                                → unpaired
 */
export function signalVerdict(signal: CrmPairingSignal): CrmPairingState {
  if (!signal.matchedLeadId) return "unpaired";
  switch (signal.matchConfidence) {
    case "deterministic":
      return "paired";
    case "strong":
      return signal.candidateCount === 1 ? "paired" : "unconfirmed";
    case "probabilistic":
      return "unconfirmed";
    case "unmatched":
      return "unpaired";
  }
}

/** A pairing whose only signal is a NAME: no shared email, phone or company domain. */
export function isNameOnlySignal(signal: CrmPairingSignal): boolean {
  return signal.matchConfidence === "probabilistic";
}

/**
 * Whether this pairing's CRM facts count as the LEAD's evidence (replies, steps, conversions, sale,
 * standing). `paired` is necessary; a name-only pairing additionally needs a PERSON's acceptance —
 * a judgment alone leaves it a "to confirm" hint (owner, 2026-10-10).
 */
export function pairingCarriesEvidence(signal: CrmPairingSignal, verdict: CrmPairingVerdict): boolean {
  if (verdict.state !== "paired") return false;
  if (isNameOnlySignal(signal)) return verdict.decidedBy === "human";
  return true;
}

/** Whether a judgment is worth paying for: only where the signal could not decide. */
export function needsJudgment(signal: CrmPairingSignal): boolean {
  return signalVerdict(signal) === "unconfirmed";
}

/** The judgment read as a verdict. `undecided` means the model hesitated and decides nothing. */
export function judgmentStatusOf(probability: number): "pair" | "reject" | "undecided" {
  if (probability >= CRM_JUDGMENT_PAIR_AT) return "pair";
  if (probability <= CRM_JUDGMENT_REJECT_AT) return "reject";
  return "undecided";
}

/**
 * The four inputs, resolved. Precedence is human > judgment > signal — a person's statement beats
 * a model's, and a model's beats a string comparison.
 */
export function resolveCrmPairing(input: CrmPairingInput): CrmPairingVerdict {
  const { signal, judgment, judgmentUnavailableReason, ruling } = input;
  const fromSignal = signalVerdict(signal);

  // Nothing matched: there is no pairing to rule on, judge, or reject.
  if (fromSignal === "unpaired") {
    return {
      state: "unpaired",
      decidedBy: null,
      toConfirm: false,
      judgmentStatus: "not_needed",
      judgmentUnavailableReason: null,
    };
  }

  const judgmentStatus: CrmJudgmentStatus = judgment
    ? judgmentStatusOf(judgment.samePersonProbability)
    : judgmentUnavailableReason
      ? "unavailable"
      : needsJudgment(signal)
        ? "not_asked"
        : "not_needed";

  // A human looked at both rows and said so. Beats everything, including a deterministic email
  // match — people share mailboxes, and the person in front of the data knows more than we do.
  if (ruling) {
    return {
      state: ruling.ruling === "accepted" ? "paired" : "rejected",
      decidedBy: "human",
      toConfirm: false,
      judgmentStatus,
      judgmentUnavailableReason: judgmentUnavailableReason ?? null,
    };
  }

  if (judgment) {
    const verdict = judgmentStatusOf(judgment.samePersonProbability);
    if (verdict === "reject") {
      return {
        state: "rejected",
        decidedBy: "judgment",
        toConfirm: false,
        judgmentStatus,
        judgmentUnavailableReason: null,
      };
    }
    // A confident yes pairs; a hesitant one pairs too — doubt leans to us — and says so. A
    // name-only pairing is ALWAYS to confirm: only a person turns a name into evidence.
    return {
      state: "paired",
      decidedBy: "judgment",
      toConfirm: verdict === "undecided" || isNameOnlySignal(signal),
      judgmentStatus,
      judgmentUnavailableReason: null,
    };
  }

  return {
    state: fromSignal,
    decidedBy: fromSignal === "paired" ? "signal" : null,
    toConfirm: false,
    judgmentStatus,
    judgmentUnavailableReason: judgmentUnavailableReason ?? null,
  };
}

// ---------------------------------------------------------------------------
// Counts — a summary is accumulated, never collected
// ---------------------------------------------------------------------------

/** `none` is the bucket for a contact nothing matched, so the methods sum to the contact count. */
export const CRM_MATCH_METHOD_KEYS = [
  "email",
  "phone",
  "domain_name",
  "full_name",
  "last_name",
  "none",
] as const;
export type CrmMatchMethodKey = (typeof CRM_MATCH_METHOD_KEYS)[number];

/** `unrecognised` holds every opportunity whose state is a word we do not read. */
export const CRM_OPPORTUNITY_STATE_KEYS = [...CRM_OPPORTUNITY_STATES, "unrecognised"] as const;
export type CrmOpportunityStateKey = (typeof CRM_OPPORTUNITY_STATE_KEYS)[number];

export interface CrmPairingCounts {
  /** Contacts their CRM holds for this brand. */
  crmContacts: number;
  /** Of those, how many carry an email at all — the only identifier that pairs deterministically here. */
  crmContactsWithEmail: number;
  byState: Record<CrmPairingState, number>;
  /**
   * Of `byState.paired`, how many rest on a hesitant judgment and wait for a person to confirm
   * them. A subset of `paired`, never a fifth state: they count for the customer exactly like a
   * confident pairing does.
   */
  pairedToConfirm: number;
  byMatchMethod: Record<CrmMatchMethodKey, number>;
  opportunities: number;
  opportunitiesByState: Record<CrmOpportunityStateKey, number>;
  /**
   * Opportunities carrying a pipeline stage name. Every one of them is uncomparable to any step
   * vocabulary of ours — the number is here so the size of that gap is measured rather than
   * asserted, which is one of the things this surface exists to learn.
   */
  opportunitiesWithUncomparableStage: number;
}

export function zeroCrmPairingCounts(): CrmPairingCounts {
  return {
    crmContacts: 0,
    crmContactsWithEmail: 0,
    byState: { paired: 0, unconfirmed: 0, rejected: 0, unpaired: 0 },
    pairedToConfirm: 0,
    byMatchMethod: {
      email: 0,
      phone: 0,
      domain_name: 0,
      full_name: 0,
      last_name: 0,
      none: 0,
    },
    opportunities: 0,
    opportunitiesByState: { open: 0, won: 0, lost: 0, abandoned: 0, unrecognised: 0 },
    opportunitiesWithUncomparableStage: 0,
  };
}

export function matchMethodKey(method: MatchMethod): CrmMatchMethodKey {
  return method ?? "none";
}

/** Fold one contact into the counters. O(1) — a summary never holds the population it summarises. */
export function addCrmPairingCounts(
  counts: CrmPairingCounts,
  entry: {
    hasEmail: boolean;
    state: CrmPairingState;
    toConfirm: boolean;
    matchMethod: MatchMethod;
    opportunityStates: Array<CrmOpportunityState | null>;
    opportunityStageNames: Array<string | null>;
  },
): void {
  counts.crmContacts += 1;
  if (entry.hasEmail) counts.crmContactsWithEmail += 1;
  counts.byState[entry.state] += 1;
  if (entry.state === "paired" && entry.toConfirm) counts.pairedToConfirm += 1;
  counts.byMatchMethod[matchMethodKey(entry.matchMethod)] += 1;
  for (const state of entry.opportunityStates) {
    counts.opportunities += 1;
    counts.opportunitiesByState[state ?? "unrecognised"] += 1;
  }
  for (const stage of entry.opportunityStageNames) {
    if (stage && stage.trim().length > 0) counts.opportunitiesWithUncomparableStage += 1;
  }
}
