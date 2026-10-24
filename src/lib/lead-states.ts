/**
 * WHEN DID EACH LEAD FIRST REACH EACH STATE at a brand (LEAD-STATES-1024, owner 2026-10-24: « Ce n'est
 * effectivement pas l'outcome "Positive Reply" qu'on track. C'est l'outcome "lead interested". Cela arrive dès la
 * première positive reply, mais ça peut aussi arriver sur un meeting booked sans positive reply. Idem avec les website
 * visits : ce n'est pas la même chose de tracker un click (website visit) et un lead ayant visité au moins une fois la
 * page (lead visit). », then « un click c'est une visite, un oui c'est un intérêt »).
 *
 * A lead outcome is a STATE reached ONCE per lead x brand, dated at its FIRST reach (3 positive replies = one
 * `lead_interested`, 12 clicks = one `lead_visited`). runs-service charges each run to the NEXT state its lead had not
 * reached at the run's time, so it reads these dates. Two families, never mixed:
 *
 *   INTEREST ladder: lead_interested < meeting_booked < meeting_attended < paid_client. Reaching a higher state
 *     reaches every lower one AT THAT DATE (a meeting booked with no positive reply = interested at the booking).
 *   VISIT: lead_visited, implied by nothing else (a yes never makes a lead visited; a click never makes them
 *     interested).
 *
 * The events are EVIDENCE of a state, each read at its REAL instant (the moment the prospect replied, clicked,
 * booked), never a sync or declaration time (`lead-states-read.ts` names each source). This module is pure: it turns
 * the earliest instant of each evidence kind into the first reach of each state.
 */

export const INTEREST_LADDER = ["lead_interested", "meeting_booked", "meeting_attended", "paid_client"] as const;
export const LEAD_VISITED = "lead_visited" as const;
export const LEAD_STATES = [...INTEREST_LADDER, LEAD_VISITED] as const;
export type LeadState = (typeof LEAD_STATES)[number];

/**
 * What evidences a state (the `basis` served beside each date):
 *   positive_reply   a reply to our outreach the sender's verdict classified positive (any provider);
 *   positive_message a personal-channel message (WhatsApp, LinkedIn...) Jev judged interest;
 *   form_reply       a form the person submitted on the brand's CRM after our first email (stored as a positive reply);
 *   meeting_booked / meeting_attended / sale   the outcome ledger (a person's statement, the CRM, the site tag, a reply);
 *   click            a measured click of our email's link to the brand's site;
 *   site_session     a session of the person on the brand's site seen by the brand's analytics (CRM fact);
 *   stated_visit     a website visit recorded on the outcome ledger (hand-stated or the site tag).
 */
export const LEAD_STATE_EVIDENCE_KINDS = [
  "positive_reply",
  "positive_message",
  "form_reply",
  "meeting_booked",
  "meeting_attended",
  "sale",
  "click",
  "site_session",
  "stated_visit",
] as const;
export type LeadStateEvidenceKind = (typeof LEAD_STATE_EVIDENCE_KINDS)[number];

export const STATE_OF_EVIDENCE: Readonly<Record<LeadStateEvidenceKind, LeadState>> = {
  positive_reply: "lead_interested",
  positive_message: "lead_interested",
  form_reply: "lead_interested",
  meeting_booked: "meeting_booked",
  meeting_attended: "meeting_attended",
  sale: "paid_client",
  click: LEAD_VISITED,
  site_session: LEAD_VISITED,
  stated_visit: LEAD_VISITED,
};

/** The earliest instant of one evidence kind for one lead x brand (ISO), or null when every instance is undated. */
export interface StateEvidence {
  kind: LeadStateEvidenceKind;
  at: string | null;
}

export interface ReachedState {
  /** First reach (ISO). null = reached, date unknown (e.g. a reply saying they were already a customer). */
  reachedAt: string | null;
  /** The evidence that reached it first. */
  basis: LeadStateEvidenceKind;
  /** The higher state whose reach implied this one (interest ladder), null when its own evidence reached it. */
  impliedBy: LeadState | null;
}

export type LeadStates = Record<LeadState, ReachedState | null>;

const ladderRank = (s: LeadState): number => (INTEREST_LADDER as readonly string[]).indexOf(s);

/**
 * Which evidence first reaches `state`: the earliest DATED candidate (a tie goes to the state's own evidence, then the
 * lower rung); only when no candidate is dated, the undated one closest to the state.
 */
function firstOf(state: LeadState, candidates: readonly StateEvidence[]): ReachedState | null {
  if (candidates.length === 0) return null;
  const rank = (e: StateEvidence) => {
    const r = ladderRank(STATE_OF_EVIDENCE[e.kind]);
    return r < 0 ? 0 : r;
  };
  const dated = candidates.filter((e) => e.at !== null);
  const pool = dated.length > 0 ? dated : [...candidates];
  pool.sort((a, b) => {
    if (a.at !== null && b.at !== null) {
      const d = Date.parse(a.at) - Date.parse(b.at);
      if (d !== 0) return d;
    }
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return LEAD_STATE_EVIDENCE_KINDS.indexOf(a.kind) - LEAD_STATE_EVIDENCE_KINDS.indexOf(b.kind);
  });
  const winner = pool[0];
  const reachedBy = STATE_OF_EVIDENCE[winner.kind];
  return { reachedAt: winner.at, basis: winner.kind, impliedBy: reachedBy === state ? null : reachedBy };
}

/** First reach of every state from a lead x brand's evidence. Pure. */
export function firstReachedStates(evidence: readonly StateEvidence[]): LeadStates {
  const out = {} as LeadStates;
  INTEREST_LADDER.forEach((state, i) => {
    out[state] = firstOf(
      state,
      evidence.filter((e) => {
        const r = ladderRank(STATE_OF_EVIDENCE[e.kind]);
        return r >= i;
      }),
    );
  });
  out[LEAD_VISITED] = firstOf(LEAD_VISITED, evidence.filter((e) => STATE_OF_EVIDENCE[e.kind] === LEAD_VISITED));
  return out;
}
