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
 * WHICH step reaches WHICH state is features-service's catalogue (`GET /public/catalogue/steps`: each step row's
 * `leadState`, `leadStateFamily`, `leadStateRank`; LEAD-STATES-1024 ottawa-v1), read, never re-mapped here: this
 * module only says which catalogue STEP each piece of evidence is (a positive reply is a `conversation`, a click a
 * `website_visit`...). A step the catalogue gives no state reaches nothing; evidence of a step the catalogue does not
 * list throws (never dropped). The events are read at their REAL instant (`lead-states-read.ts`).
 */

/** The states served, one key each (the catalogue's state rows). */
export const INTEREST_LADDER = ["lead_interested", "meeting_booked", "meeting_attended", "paid_client"] as const;
export const LEAD_VISITED = "lead_visited" as const;
export const LEAD_STATES = [...INTEREST_LADDER, LEAD_VISITED] as const;
export type LeadState = (typeof LEAD_STATES)[number];

/**
 * What evidences a state (the `basis` served beside each date) and the catalogue step it is:
 *   positive_reply   a reply to our outreach the sender's verdict classified positive (any provider) -> conversation;
 *   positive_message a personal-channel message (WhatsApp, LinkedIn...) Jev judged interest -> conversation;
 *   form_reply       a CRM form after our first email (stored as a positive reply) -> conversation;
 *   signup / form_submitted   the outcome ledger or the brand's CRM -> signup / form_submitted;
 *   booking_call     a booking call placed with the person (AI Instant Call's act) -> booking_call;
 *   meeting_booked / meeting_attended / sale   the outcome ledger -> meeting_booked / meeting_attended / paid_client;
 *   click            a measured click of our email's link to the brand's site -> website_visit;
 *   site_session     a session on the brand's site seen by the brand's analytics (CRM fact) -> website_visit;
 *   stated_visit     a website visit recorded on the outcome ledger -> website_visit.
 */
export const STEP_OF_EVIDENCE = {
  positive_reply: "conversation",
  positive_message: "conversation",
  form_reply: "conversation",
  signup: "signup",
  form_submitted: "form_submitted",
  booking_call: "booking_call",
  meeting_booked: "meeting_booked",
  meeting_attended: "meeting_attended",
  sale: "paid_client",
  click: "website_visit",
  site_session: "website_visit",
  stated_visit: "website_visit",
} as const;
export type LeadStateEvidenceKind = keyof typeof STEP_OF_EVIDENCE;
export const LEAD_STATE_EVIDENCE_KINDS = Object.keys(STEP_OF_EVIDENCE) as LeadStateEvidenceKind[];

/** One catalogue step's state: the state it reaches, the state's family and its rank in the family. */
export interface StepLeadState {
  state: string;
  family: string;
  rank: number;
}

/** step key -> its state (a step reaching no state is absent). */
export type LeadStateCatalogue = ReadonlyMap<string, StepLeadState>;

export class LeadStateCatalogueError extends Error {}

/** Every served state must be a catalogue step reaching itself, and every evidence step must be listed. Throws. */
export function assertCatalogueCovers(catalogue: LeadStateCatalogue, listedSteps: ReadonlySet<string>): void {
  for (const s of LEAD_STATES) {
    const own = catalogue.get(s);
    if (!own || own.state !== s) throw new LeadStateCatalogueError(`catalogue serves no state row for "${s}"`);
  }
  for (const step of new Set(Object.values(STEP_OF_EVIDENCE))) {
    if (!listedSteps.has(step)) throw new LeadStateCatalogueError(`catalogue does not list step "${step}"`);
  }
}

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
  /** The higher state whose reach implied this one (same family), null when the state's own evidence reached it. */
  impliedBy: string | null;
}

export type LeadStates = Record<LeadState, ReachedState | null>;

/** First reach of every state from a lead x brand's evidence, per the catalogue. Pure. */
export function firstReachedStates(evidence: readonly StateEvidence[], catalogue: LeadStateCatalogue): LeadStates {
  const placed = evidence.flatMap((e) => {
    const s = catalogue.get(STEP_OF_EVIDENCE[e.kind]);
    return s ? [{ ...e, s }] : [];
  });
  const out = {} as LeadStates;
  for (const state of LEAD_STATES) {
    const target = catalogue.get(state);
    if (!target) throw new LeadStateCatalogueError(`catalogue serves no state row for "${state}"`);
    const candidates = placed.filter((p) => p.s.family === target.family && p.s.rank >= target.rank);
    if (candidates.length === 0) {
      out[state] = null;
      continue;
    }
    const dated = candidates.filter((p) => p.at !== null);
    const pool = dated.length > 0 ? dated : [...candidates];
    pool.sort((a, b) => {
      if (a.at !== null && b.at !== null) {
        const d = Date.parse(a.at) - Date.parse(b.at);
        if (d !== 0) return d;
      }
      const r = a.s.rank - b.s.rank;
      if (r !== 0) return r;
      return LEAD_STATE_EVIDENCE_KINDS.indexOf(a.kind) - LEAD_STATE_EVIDENCE_KINDS.indexOf(b.kind);
    });
    const w = pool[0];
    out[state] = { reachedAt: w.at, basis: w.kind, impliedBy: w.s.state === state ? null : w.s.state };
  }
  return out;
}
