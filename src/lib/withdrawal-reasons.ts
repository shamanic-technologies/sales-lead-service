/**
 * Why a conversion was set aside (`conversion_events.withdrawn_reason`, migration 0120, FAKE-OUTCOMES-1022).
 * NULL = every older withdrawal (a person's step statement, the CRM sync's stale rows).
 */
/** A person withdrew it: POST /orgs/brands/{brandId}/conversions/{id}/withdraw, `withdrawn_note` = their words. */
export const WRONG_ATTRIBUTION_WITHDRAWAL = "wrong_attribution";
/** Sent by a staff address: set aside at ingest. */
export const STAFF_IDENTITY_WITHDRAWAL = "staff_identity";
/** Its lead is marked not a real person in the org (not-a-person.ts). */
export const NOT_A_PERSON_WITHDRAWAL = "not_a_person";
