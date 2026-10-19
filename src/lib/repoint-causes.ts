// Pure vocabulary (no db import): src/schemas.ts reads it, and the OpenAPI build runs with no database.

/**
 * Every `lead_campaign_run_repoints.cause` a writer records (the table's CHECK, migration 0101): a retry-pool
 * claim, a named serve, a "Lead follow-up due" serve re-opening the row for its next round.
 * A new re-pointer adds its cause HERE (tests/unit/repoint-causes.test.ts pins writers + CHECK to this list).
 */
export const REPOINT_CAUSES = ["retry_claim", "named_serve", "followup_due"] as const;
export type RepointCause = (typeof REPOINT_CAUSES)[number];

/** Which record named the sending workflow: the row's serve, or a re-point of the row to the sending run. */
export const EMAIL_SEND_WORKFLOW_SOURCES = ["serve", ...REPOINT_CAUSES] as const;
export type EmailSendWorkflowSource = (typeof EMAIL_SEND_WORKFLOW_SOURCES)[number];
