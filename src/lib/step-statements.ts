/**
 * A step outcome a HUMAN states about one lead, and its negative twin.
 *
 * The website tracker reports what it can see. It sees roughly one conversion in ten: 26 of the
 * 29 conversion events ever received are `unmatched`, almost always because the person signed up
 * with an address we never emailed. Everything the tracker cannot see — a meeting somebody took,
 * a deal that closed on a call — has, until now, lived as typed notes in whichever tool the person
 * happened to be looking at, where nothing that computes the funnel, the ROI or the cost per
 * acquisition can read it.
 *
 * So a person looking at ONE lead states the fact themselves, and it counts exactly like a tracked
 * one. Two statements are possible about a step, and they are NOT the same kind of thing:
 *
 *   - an OUTCOME — "this happened". Stored in `conversion_events`, the ledger every consumer
 *     already counts, tagged `source = 'manual'`. Nothing downstream had to change for a
 *     hand-stated signup to move the brand's signup count, and `source` keeps it distinguishable
 *     from a tracker-reported one after the fact.
 *   - a NEVER — "this will not happen". NOT an outcome, so it deliberately does not live in that
 *     ledger at all: it is a `lead_step_disqualifications` row, which nothing counts. Its only job
 *     is to let a consumer tell a lead that is DEAD at a step from one still PENDING, which
 *     nothing could do before — the difference between a cost-per-acquisition denominator that is
 *     still waiting and one that never will be.
 *
 * The identity is the lead row itself (`leads_campaigns.id`, the id a list row already carries),
 * so the caller re-supplies nothing and the statement is attributable to the campaign the row
 * belongs to, not merely to the brand.
 */
import {
  CONVERSION_EVENTS,
  canonicalizeConversionEvent,
  type ConversionEventName,
} from "./conversions.js";

/**
 * A meeting somebody actually ATTENDED. Sales funnels have carried this step all along and
 * brand-service prices with a booked-to-attended rate, but no event of the kind existed anywhere
 * in the fleet, so that rate could never be measured against reality.
 *
 * It is deliberately NOT accepted by the website tracker: attendance happens off the client's
 * website, so a page-load tag has nothing to observe. The tracker's ingest vocabulary is
 * unchanged; this name is statable by hand only.
 */
export const MEETING_ATTENDED = "meeting_attended" as const;

/**
 * The lead LANDED ON the brand's website. Two of the four sales funnels START here, and until now
 * it was the one step of those funnels nobody could state: the panel showed a row it could only
 * read above three it could act on, and there was no way at all to correct the first step when the
 * automatic signal missed it.
 *
 * The automatic signal is a CLICK measured by the delivery layer (email-gateway), and it misses
 * for the same family of reasons the tracker's identity waterfall misses. A hand-stated visit ADDS
 * to that; it never replaces or suppresses it, and the delivery layer is not touched. It is
 * deliberately NOT accepted by the website tracker's ingest either — the tracker already reports
 * what it can see, and its vocabulary is unchanged — so, like `meeting_attended`, this name is
 * statable by hand only.
 */
export const WEBSITE_VISIT = "website_visit" as const;

export type LeadStepOutcomeName =
  | ConversionEventName
  | typeof MEETING_ATTENDED
  | typeof WEBSITE_VISIT;

/**
 * Every outcome a step of a sales funnel can carry — the four the tracker reports plus the two
 * only a human can state. This is the vocabulary the COUNT contracts answer for; `CONVERSION_EVENTS`
 * stays the (narrower) set the public tracker ingest accepts.
 */
export const LEAD_STEP_OUTCOMES: readonly LeadStepOutcomeName[] = [
  ...CONVERSION_EVENTS,
  MEETING_ATTENDED,
  WEBSITE_VISIT,
];

/**
 * Canonicalize a step name for the OUTCOME vocabulary: the four tracker events (legacy
 * "purchase" folded to "sale", exactly as the ingest folds it) plus "meeting_attended".
 * Anything else — "ping", garbage, a non-string — is null, and every caller 400s on null.
 */
export function canonicalizeStepOutcome(value: unknown): LeadStepOutcomeName | null {
  if (value === MEETING_ATTENDED) return MEETING_ATTENDED;
  if (value === WEBSITE_VISIT) return WEBSITE_VISIT;
  return canonicalizeConversionEvent(value);
}

/**
 * Where a step's evidence came from. Frozen on the row at write, never inferred on read.
 *
 *   manual  — a person stated it. The only source a person can withdraw.
 *   tracker — the brand's website tag reported it (or the delivery layer measured the click).
 *   crm     — the customer's OWN CRM evidences it, for a lead paired with that CRM contact
 *             (crm-evidence.ts). Not a person's statement: it is corrected by rejecting the pairing,
 *             or overridden by a person stating the step.
 */
export type StatementSource = "tracker" | "manual" | "crm";
export const STATEMENT_SOURCES: readonly StatementSource[] = ["tracker", "manual", "crm"];

/**
 * A stored `source` read back. Anything that is not explicitly `manual` or `crm` came off the
 * website tracker — which is what every row written before the column existed is.
 */
export function statementSourceOf(raw: unknown): StatementSource {
  if (raw === "manual") return "manual";
  if (raw === "crm") return "crm";
  return "tracker";
}

/** What a human stated about a step: it happened, or it never will. */
export type StatementKind = "outcome" | "never";
export const STATEMENT_KINDS: readonly StatementKind[] = ["outcome", "never"];

/** What a consumer reads back per step. `pending` is the absence of both statements. */
export type StepState = "outcome" | "never" | "pending";

/**
 * The dedupe signature a hand-stated OUTCOME carries in `conversion_events`.
 *
 * Keyed on the lead ROW and the step, so restating the same step for the same lead corrects the
 * first statement (value, note, when) instead of counting a second time — the same guarantee the
 * tracker's own (brand, event, identity, day) signature gives, expressed for a caller that names
 * the lead outright. The `m:` prefix keeps it disjoint from the tracker's `k:`/`a:` signatures.
 */
export function manualOutcomeSignature(leadCampaignId: string, step: LeadStepOutcomeName): string {
  return `m:${leadCampaignId}:${step}`;
}

/**
 * WHOSE win an outcome was — did OUR outreach cause it, or something else the customer already
 * does (a referral, a conference, an existing pipeline, another agency)?
 *
 * A brand does not only talk to people through us, so some of the people we email go on to buy for
 * reasons that have nothing to do with us. A deal like that is a REAL closed deal — it is recorded,
 * it is counted among the brand's own outcomes, and stating it honestly must never cost the person
 * stating it anything — but a consumer computing the return on OUR outreach has to be able to leave
 * its value out, and until this existed it could not tell the two apart at all.
 *
 * Three states, and the third is not a shade of either:
 *
 *   outreach — the customer says our outreach caused it (`caused_by_outreach = true`).
 *   other    — the customer says something else of theirs did (`false`).
 *   unstated — NOBODY WAS ASKED (`null`): every statement made before this existed, and every
 *              tracker-reported outcome, because a page-load tag observes a page load and cannot
 *              know why somebody bought. Never defaulted into either answer.
 *
 * This is deliberately NOT `attribution_status` (attributed / needs_review / unmatched), which
 * answers whether the tracker managed to identify WHO somebody was. Conflating a fact about our
 * identity matching with a fact about what caused a deal makes both unreadable.
 */
export type OutcomeCause = "outreach" | "other" | "unstated";

export const OUTCOME_CAUSES: readonly OutcomeCause[] = ["outreach", "other", "unstated"];

/** Which bucket a stored `caused_by_outreach` falls in. Null is its own answer, never a default. */
export function outcomeCauseOf(causedByOutreach: boolean | null | undefined): OutcomeCause {
  if (causedByOutreach === true) return "outreach";
  if (causedByOutreach === false) return "other";
  return "unstated";
}
