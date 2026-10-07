/**
 * Why a serve came back empty.
 *
 * `POST /orgs/buffer/next` answering `{ found: false }` used to say nothing more, so five
 * different situations arrived on the wire byte-identical. The caller acts on one of them
 * irreversibly — it stops the campaign, and funding a channel deliberately never revives a
 * campaign stopped for exhaustion — so "the audience has nobody left" MUST NOT look like
 * "I did not look for anybody".
 *
 * Exactly ONE value is evidence that a population ran out:
 *
 *   audience_exhausted — human-service walked the audience this service was told to serve and
 *                        reported nobody left. This is the only answer here that a caller may
 *                        treat as terminal.
 *
 * Every other value states that no exhaustion was observed, for a different reason each time:
 *
 *   no_audience            — the caller named no audience (no x-audience-id). This service does
 *                            not pick audiences (campaign-service owns selection and propagates
 *                            it down the DAG), so it never looked at a single person. Says
 *                            nothing at all about whether people remain.
 *   serve_timed_out        — the serve budget expired before the look finished. An unfinished
 *                            look, not an empty one.
 *   audience_not_serveable — the named audience has no committed provider, so it cannot be
 *                            walked yet. Its population is unknown, not empty.
 *   credit_insufficient    — the org has no platform credit, so no paid search/enrichment ran.
 *   source_campaign_off    — the audience's origin is a SOURCE campaign of the offer that is OFF
 *                            (src/lib/source-campaign.ts): nothing is bought from a source the
 *                            customer did not turn on. Says nothing about the audience's people.
 *   source_budget_reached  — that source campaign already spent its daily budget today.
 *
 * A caller decides "may I stop?" by testing for `audience_exhausted` specifically, never by
 * excluding a list of known-benign reasons: a reason added here later must default to
 * not-exhaustion, and only an explicit equality test gives that.
 */

export const AUDIENCE_EXHAUSTED_REASON = "audience_exhausted" as const;
export const NO_AUDIENCE_REASON = "no_audience" as const;
export const SERVE_TIMED_OUT_REASON = "serve_timed_out" as const;
export const AUDIENCE_NOT_SERVEABLE_REASON = "audience_not_serveable" as const;
export const CREDIT_INSUFFICIENT_REASON = "credit_insufficient" as const;
export const SOURCE_CAMPAIGN_OFF_REASON = "source_campaign_off" as const;
export const SOURCE_BUDGET_REACHED_REASON = "source_budget_reached" as const;

/** Every reason `POST /orgs/buffer/next` can attach to `{ found: false }`. */
export const SERVE_EMPTY_REASONS = [
  AUDIENCE_EXHAUSTED_REASON,
  NO_AUDIENCE_REASON,
  SERVE_TIMED_OUT_REASON,
  AUDIENCE_NOT_SERVEABLE_REASON,
  CREDIT_INSUFFICIENT_REASON,
  SOURCE_CAMPAIGN_OFF_REASON,
  SOURCE_BUDGET_REACHED_REASON,
] as const;

export type ServeEmptyReason = (typeof SERVE_EMPTY_REASONS)[number];

/**
 * Is this answer evidence that the audience ran out of people?
 *
 * Only `audience_exhausted` is. Anything else — including an absent reason, which is what
 * every pre-v0.56 response carried — is not, so a caller reading an older response cannot
 * mistake it for exhaustion either.
 */
export function isAudienceExhaustedReason(reason: string | null | undefined): boolean {
  return reason === AUDIENCE_EXHAUSTED_REASON;
}
