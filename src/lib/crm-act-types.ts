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
