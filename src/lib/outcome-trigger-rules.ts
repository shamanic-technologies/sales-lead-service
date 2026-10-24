/**
 * EVERY OUTCOME A PERSON REACHES FIRES ITS OUTCOME TRIGGER — the pure rules (EVERY-OUTCOME-FIRES-1015, owner
 * 2026-10-15: "Every outcome reached fires its trigger, no exception"). The IO is `outcome-triggers.ts`.
 *
 *  - WHICH trigger: features-service's catalogue (`GET /public/channels` `triggers[]`) states exactly one
 *    `type: "outcome"` trigger per outcome, `outcomeKey` = the outcome's step key. It is READ, never a slug list
 *    here. An outcome with no outcome trigger fires nothing (`no_outcome_trigger`).
 *  - WHO fires it: an outcome trigger another service fires TODAY (`coded: true`, `firedBy` not this service:
 *    Positive reply = instantly-service, Form submitted = crm-service) is never fired a second time here
 *    (`fired_by_another_service`). Every other outcome trigger this service sees a reach of, it fires.
 *  - WHAT reaches a step: this service's own vocabulary, the one `step-reached.ts` already states for
 *    campaign-service's delay detector (crm fact types + outcome-ledger events; a sale the brand's website tag
 *    reported is Direct purchase AND Paid client), plus `lead_found` (a person
 *    FOUND by a serve) and `booking_call` (an `acted` row of an AI Instant Call campaign, booking-calls.ts).
 *  - FROM NOW ON (no back-fill): a reach fires only when it happened after the detector was armed AND within
 *    `OUTCOME_FRESH_WINDOW_MS` of now. An undated reach never fires (nothing says it is not years old), and
 *    neither does a CRM's first import of its history.
 *  - ONCE per person (lead x brand x offer) and trigger: the idempotency key names the outcome, the brand, the
 *    offer and the person, so our own retry and a replay both answer the first event at campaign-service.
 */
import { STEP_REACHED_EVIDENCE, ledgerRowReachesStep } from "./step-reached.js";
import { canonicalE164 } from "./e164-phone.js";

/** How this service is named in features-service's catalogue (`triggers[].firedBy`). */
export const OUTCOME_TRIGGER_SELF = "lead-service";

/** A reach older than this when it is seen fires nothing: a history import, never an outcome reached now. */
export const OUTCOME_FRESH_WINDOW_MS = 24 * 60 * 60_000;

/** A serve that FOUND a person (`recordServed`, buffer.ts) reaches this step. */
export const LEAD_FOUND_STEP = "lead_found";
/** An AI Instant Call act on the person (booking-calls.ts) reaches this step. */
export const BOOKING_CALL_STEP = "booking_call";

/** One outcome trigger, as features-service serves it. */
export interface CatalogueOutcomeTrigger {
  id: string;
  outcomeKey: string;
  firedBy: string;
  coded: boolean;
}

/**
 * The outcome triggers of a `/public/channels` body. THROWS on an unreadable list (no `triggers` array, an
 * outcome trigger missing its id / outcomeKey / firedBy / coded): a guess would fire the wrong trigger or skip one.
 */
export function parseOutcomeTriggers(body: unknown): CatalogueOutcomeTrigger[] {
  const triggers = (body as { triggers?: unknown } | null)?.triggers;
  if (!Array.isArray(triggers)) throw new Error("features-service /public/channels answered without a triggers array");
  const out: CatalogueOutcomeTrigger[] = [];
  for (const raw of triggers) {
    const t = raw as Record<string, unknown> | null;
    if (!t || t.type !== "outcome") continue;
    if (typeof t.id !== "string" || typeof t.outcomeKey !== "string" || typeof t.firedBy !== "string" || typeof t.coded !== "boolean") {
      throw new Error(`features-service outcome trigger unreadable (id, outcomeKey, firedBy, coded): ${JSON.stringify(t).slice(0, 300)}`);
    }
    out.push({ id: t.id, outcomeKey: t.outcomeKey, firedBy: t.firedBy, coded: t.coded });
  }
  return out;
}

export type OutcomeTriggerVerdict =
  | { fire: true; triggerId: string }
  | { fire: false; reason: "no_outcome_trigger" | "fired_by_another_service"; triggerId: string | null; detail: string };

/** Which trigger a reach of `step` fires here, or why none. */
export function outcomeTriggerFor(step: string, triggers: readonly CatalogueOutcomeTrigger[]): OutcomeTriggerVerdict {
  const trigger = triggers.find((t) => t.outcomeKey === step);
  if (!trigger) {
    return { fire: false, reason: "no_outcome_trigger", triggerId: null, detail: `the catalogue states no outcome trigger for "${step}"` };
  }
  if (trigger.coded && trigger.firedBy !== OUTCOME_TRIGGER_SELF) {
    return {
      fire: false,
      reason: "fired_by_another_service",
      triggerId: trigger.id,
      detail: `${trigger.firedBy} fires ${trigger.id}`,
    };
  }
  return { fire: true, triggerId: trigger.id };
}

/** The catalogue step a crm fact type reaches (step-reached.ts vocabulary), or null. */
export function stepOfCrmFact(type: string): string | null {
  for (const [step, evidence] of Object.entries(STEP_REACHED_EVIDENCE)) {
    if (evidence.crmFactTypes.includes(type)) return step;
  }
  return null;
}

/**
 * Every catalogue step an outcome-ledger row (`conversion_events.event` + `source`) reaches, in catalogue order.
 * One row can reach two: a sale the brand's website tag reported is a Direct purchase AND a Paid client.
 */
export function stepsOfLedgerRow(event: string, source: string): string[] {
  return Object.keys(STEP_REACHED_EVIDENCE).filter((step) => ledgerRowReachesStep(step, event, source));
}

/**
 * The record a reach of `step` off ledger row `ceId` is kept under: `ce:<id>` for a step any source reaches (every
 * row read before a row could reach two steps), `ce:<id>:<step>` for a step only some sources reach (Direct purchase).
 */
export function ledgerSourceRef(ceId: string, step: string): string {
  return STEP_REACHED_EVIDENCE[step]?.ledgerSources ? `ce:${ceId}:${step}` : `ce:${ceId}`;
}

/** Ledger events a step reachable from ANY source reads (their reach is kept under the bare `ce:<id>`). */
export const LEDGER_ANY_SOURCE_EVENTS: readonly string[] = [
  ...new Set(Object.values(STEP_REACHED_EVIDENCE).filter((e) => !e.ledgerSources).flatMap((e) => e.ledgerEvents)),
];

/** Steps only some ledger sources reach, with what reaches them (each kept under `ce:<id>:<step>`). */
export const LEDGER_SOURCE_BOUND_STEPS: ReadonlyArray<{ step: string; events: readonly string[]; sources: readonly string[] }> =
  Object.entries(STEP_REACHED_EVIDENCE)
    .filter(([, e]) => e.ledgerSources && e.ledgerEvents.length > 0)
    .map(([step, e]) => ({ step, events: e.ledgerEvents, sources: e.ledgerSources! }));

export const CRM_FACT_REACH_TYPES: readonly string[] = Object.values(STEP_REACHED_EVIDENCE).flatMap((e) => e.crmFactTypes);
export const LEDGER_REACH_EVENTS: readonly string[] = [...new Set(Object.values(STEP_REACHED_EVIDENCE).flatMap((e) => e.ledgerEvents))];

/** The earliest instant a reach may have happened at and still fire (armed, and inside the window). */
export function freshSince(armedAt: Date, now: Date): Date {
  return new Date(Math.max(armedAt.getTime(), now.getTime() - OUTCOME_FRESH_WINDOW_MS));
}

/** Whether a reach dated `at` fires now. Undated never fires. */
export function isFreshReach(at: string | Date | null, armedAt: Date, now: Date): boolean {
  if (at === null) return false;
  const t = (at instanceof Date ? at : new Date(at)).getTime();
  if (!Number.isFinite(t)) return false;
  return t >= freshSince(armedAt, now).getTime();
}

/** The person a fire is ONCE for: the lead when there is one, else their canonical address. */
export function personKeyOf(leadId: string | null, email: string | null): string | null {
  if (leadId) return `lead:${leadId}`;
  if (email) return `email:${email}`;
  return null;
}

/**
 * campaign-service's idempotency key (unique per org, at most 200 chars): the outcome, the brand, the offer and
 * the person. An address never rides it raw (length, and it is not an identifier anybody needs to read there).
 */
export function outcomeIdempotencyKey(input: { step: string; brandId: string; offerId: string; personKey: string; hash: (s: string) => string }): string {
  const person = input.personKey.startsWith("lead:") ? input.personKey : `email:${input.hash(input.personKey).slice(0, 32)}`;
  return `lead-service:outcome:${input.step}:${input.brandId}:${input.offerId}:${person}`;
}

export type OfferAnswer =
  | { offerIds: string[]; basis: "stated" | "lead_campaigns" | "live_campaigns" | "only_offer" }
  | { offerIds: []; reason: "offer_unknown"; detail: string };

/**
 * The offer(s) a reach is about (campaign-service runs campaigns per (brand, offer), so every event names one).
 * First that answers: the offer the record states (the serve's campaign, the statement's campaign, the acting
 * campaign); the offers of the campaigns the person is a lead of at the brand (one event each: the person is a
 * lead of each); the brand's offers whose ONGOING campaign answers the trigger (campaign-service
 * `/internal/brands/{id}/trigger-offers`, OFFER-FROM-LIVE-CAMPAIGNS-1024: an inbound visitor is in no campaign, and
 * with 2+ offers their event used to die `offer_unknown` before reaching the Lead event campaign); the brand's ONLY
 * active offer. Else `offer_unknown`, never a guess.
 */
export function pickOffers(input: {
  stated: string | null;
  leadCampaignOffers: readonly (string | null)[];
  /** null = not asked (the record or the person's campaigns already answer, or no trigger fires here). */
  liveTriggerOffers?: readonly string[] | null;
  activeBrandOffers: readonly string[] | null;
}): OfferAnswer {
  if (input.stated) return { offerIds: [input.stated], basis: "stated" };
  const fromLead = [...new Set(input.leadCampaignOffers.filter((o): o is string => typeof o === "string" && o.length > 0))].sort();
  if (fromLead.length > 0) return { offerIds: fromLead, basis: "lead_campaigns" };
  const live = [...new Set((input.liveTriggerOffers ?? []).filter((o) => typeof o === "string" && o.length > 0))].sort();
  if (live.length > 0) return { offerIds: live, basis: "live_campaigns" };
  const active = input.activeBrandOffers ?? [];
  if (active.length === 1) return { offerIds: [active[0]], basis: "only_offer" };
  return {
    offerIds: [],
    reason: "offer_unknown",
    detail:
      active.length === 0
        ? "no campaign of the person states an offer, no live campaign answers the trigger, and the brand has no active offer"
        : `no campaign of the person states an offer, no live campaign answers the trigger, and the brand has ${active.length} active offers`,
  };
}

/**
 * A person as campaign-service's contract takes it (name <= 300, phone <= 50): by address, else by E.164 phone alone
 * (a WhatsApp writer with no email, REPLY-PHONE-ONLY-1015). Neither = no person (the event names the lead only).
 */
export function eventPerson(
  email: string | null,
  name: string | null,
  phone: string | null,
): { email?: string; name?: string; phone?: string } | null {
  const named = name && name.trim() ? { name: name.trim().slice(0, 300) } : {};
  if (email) return { email, ...named, ...(phone && phone.trim() ? { phone: phone.trim().slice(0, 50) } : {}) };
  const e164 = canonicalE164(phone);
  return e164 ? { phone: e164, ...named } : null;
}

/** Canonical (trimmed, lowercased) addresses, order kept, empties and non-addresses dropped. */
export function canonicalEmails(emails: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const e of emails) {
    if (typeof e !== "string") continue;
    const c = e.trim().toLowerCase();
    if (c.includes("@") && !out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * ONE FIRE PER REAL ACTION, whatever crm-service does to the fact afterwards (MERGE-NO-REFIRE-1024, owner 2026-10-24:
 * "a merge must never fire a trigger by itself, nor fire the same action twice"). crm-service RE-STATES a live fact
 * when its person changes (two people merged, a fleet human identified, a CRM contact re-minted): the old copy is
 * withdrawn and a new fact id carries the SAME source, source ref, type and date under the new person (another
 * address, another lead). Read as a new record, it would fire again under a person key the once-index never saw.
 * A re-statement is skipped `restated_action` when an earlier copy of the same action was already answered:
 * fired, waiting, refused, kept `already_fired`, or skipped at the door. Only an earlier copy that could not NAME
 * its person or offer (`no_person`, `offer_unknown`, `unresolvable`) never answered: its first nameable copy fires once.
 */
export const RESTATED_ACTION = "restated_action";

/** Skips decided before the door was asked: the action has not fired yet. */
export const UNANSWERED_SKIPS: readonly string[] = ["no_person", "offer_unknown", "unresolvable"];

/** Whether an earlier copy of the same action already answered its trigger (see RESTATED_ACTION). */
export function actionAlreadyAnswered(earlierCopies: ReadonlyArray<{ status: string; skipReason: string | null }>): boolean {
  return earlierCopies.some((r) => r.status !== "skipped" || !UNANSWERED_SKIPS.includes(r.skipReason ?? ""));
}
