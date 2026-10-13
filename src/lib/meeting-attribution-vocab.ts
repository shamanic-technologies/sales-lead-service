/**
 * The vocabulary of meeting attribution (meeting-attribution.ts), apart from its IO so `schemas.ts`
 * can import it: the OpenAPI generation runs with no database configured.
 */
export const MEETING_ARMS = ["aiMeetingBooking", "yourTeamMeetingBooking", "other", "unknown"] as const;
export type MeetingArm = (typeof MEETING_ARMS)[number];

export const MEETING_UNKNOWN_REASONS = [
  "person_unknown",
  "match_needs_review",
  "undated",
  "no_positive_reply_before",
  "no_answer_before_meeting",
  "ai_campaign_unknown",
] as const;
export type MeetingUnknownReason = (typeof MEETING_UNKNOWN_REASONS)[number];

export const MEETING_ANSWER_VIAS = ["followup_ledger", "reply_sent", "gmail_answer", "answered_outside"] as const;
