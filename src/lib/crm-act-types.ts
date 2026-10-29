import { sql, type SQL } from "drizzle-orm";

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
 * A product event the person did NOT do in front of the brand (ONE-AI-CONVERSES-1029-LEADFACTS, pure + SQL twin): crm
 * states the session each product event happened in (`payload.sessionId`); an event its source states in NO session
 * (key present, value null) was recorded by the brand's own SERVER about them, never by their browser: an identify when
 * a newsletter link is hit (mail security scanners hit every link, three times in a second), an org minted for an
 * anonymous visitor. Our plumbing, not their act: it rings no Lead event and never makes them "acted toward us". A real
 * visit through that link arrives on its own (a session = `website_visit`). A source stating no session key at all is
 * left alone (nothing positive says it was a server).
 * Prod 2026-10-29: 10,531 `newsletter_link_identified` + 33 `anonymous_org_created`, every one sessionless; every
 * other product event (1,677 onboarding steps, 753 sign-ins...) carries its session.
 */
export const PRODUCT_EVENT_TYPE = "product_event";

export function isSessionlessProductEvent(type: string, payload: Record<string, unknown> | null | undefined): boolean {
  return type === PRODUCT_EVENT_TYPE && payload != null && "sessionId" in payload && payload.sessionId == null;
}

/** SQL twin of `isSessionlessProductEvent` on a `crm_facts` row alias. */
export function sessionlessProductEventSql(f: SQL): SQL {
  return sql`(${f}.type = ${PRODUCT_EVENT_TYPE} AND ${f}.payload ? 'sessionId' AND ${f}.payload->>'sessionId' IS NULL)`;
}
