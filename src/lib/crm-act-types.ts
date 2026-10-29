/**
 * Which crm fact types are NOT an act of the person (pure, no I/O): ours (`message_out`), corrections, CRM bookkeeping,
 * a no-show. Every other type is something they did (lead-followup-date.ts `actedTowardUsSql`, and the act that rings
 * Lead event, outcome-trigger-rules.ts `isTheirNewAct`), so a kind of act crm-service starts stating counts the day it lands.
 */
export const CRM_NOT_THEIR_ACT = [
  "message_out",
  "withdrawn",
  "person_merged",
  "person_split",
  "added_to_crm",
  "group_member",
  "deal_status_changed",
  // A CRM stage / tag saying they are no longer a client (crm-service v0.73.0): bookkeeping, not an act of theirs.
  "former_client",
  "disqualified",
  "meeting_not_held",
] as const;

/**
 * Product events (`product_event`, `payload.event`) that OUR code captures about a person, never something they did
 * toward us (ONE-AI-CONVERSES-1029-LEADFACTS, owner 2026-10-24: a Lead event is « any new Unibox event of THEIR action
 * toward us »). Data, one line per event with its reason; a new instrumentation event is a line here.
 *  - `newsletter_link_identified`: our server ties a newsletter link id to the PostHog person (distribute.you
 *    `subscriber-link.ts`, a server-side capture, `source: server`). It fires once per tab session that opens the
 *    link, mail scanners included (prod 2026-10-29: 7,280 in 3 days vs 128 website visits; one address 4 in 2 s with
 *    no visit at all), and the person's real act, the visit, is stated by crm-service as its own `website_visit`.
 *  - `landing_variant_viewed`: our A/B split recording which landing variant it served on a visit, the same visit
 *    `website_visit` already states.
 */
export const OUR_INSTRUMENTATION_EVENTS = ["newsletter_link_identified", "landing_variant_viewed"] as const;

/** Whether a crm fact is our own instrumentation about the person (OUR_INSTRUMENTATION_EVENTS), not an act of theirs. */
export function isOurInstrumentation(type: string, payload: Record<string, unknown> | null | undefined): boolean {
  const event = payload?.event;
  return type === "product_event" && typeof event === "string" && (OUR_INSTRUMENTATION_EVENTS as readonly string[]).includes(event);
}
