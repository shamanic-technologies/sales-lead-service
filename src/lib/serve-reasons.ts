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
 *   source_stock_empty     — the outreach campaign is fed by source campaigns that FIND leads in their own
 *                            runs (src/lib/source-mode.ts), and none of them holds a found lead nobody worked
 *                            yet that still fits its audience (a find that stopped fitting is set aside on the
 *                            way, src/lib/source-stock.ts). Nothing is found on demand from such a source: the
 *                            stock refills on the source's next run. Says nothing about any audience's people.
 *   origin_not_fed         — the named audience serves from an origin the campaign's outreach channel is NOT fed
 *                            by (features-service `originsByChannel`): nobody is served from it for this pipe
 *                            (owner 2026-10-12). A wrong audience was named; says nothing about its people.
 *   audience_offer_mismatch — the named audience belongs to another offer than the one the campaign sells.
 *   no_recent_posts        — a linkedin_engagement audience human-service was asked to serve answered `exhausted`
 *                            with its own reason `no_recent_posts`: the competitor pages it reads engagers from
 *                            hold NO post inside its window, so there was nobody to read (owner 2026-10-13, Doc
 *                            Dinners: ChiroCandy + MaxLiving had posted nothing). Not a population that ran out:
 *                            the audience fills as soon as a competitor posts. Wins over every other empty answer
 *                            of a walk that served nobody (a look found nothing to read, so not all walked out).
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
export const SOURCE_STOCK_EMPTY_REASON = "source_stock_empty" as const;
export const ORIGIN_NOT_FED_REASON = "origin_not_fed" as const;
export const AUDIENCE_OFFER_MISMATCH_REASON = "audience_offer_mismatch" as const;
export const NO_RECENT_POSTS_REASON = "no_recent_posts" as const;

/** Every reason `POST /orgs/buffer/next` can attach to `{ found: false }`. */
export const SERVE_EMPTY_REASONS = [
  AUDIENCE_EXHAUSTED_REASON,
  NO_AUDIENCE_REASON,
  SERVE_TIMED_OUT_REASON,
  AUDIENCE_NOT_SERVEABLE_REASON,
  CREDIT_INSUFFICIENT_REASON,
  SOURCE_CAMPAIGN_OFF_REASON,
  SOURCE_BUDGET_REACHED_REASON,
  SOURCE_STOCK_EMPTY_REASON,
  ORIGIN_NOT_FED_REASON,
  AUDIENCE_OFFER_MISMATCH_REASON,
  NO_RECENT_POSTS_REASON,
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

/**
 * Did human-service answer "exhausted" because the audience had nothing to read yet (a
 * linkedin_engagement audience whose competitor pages hold no post in its window)? That answer
 * maps to `no_recent_posts`, never to `audience_exhausted`.
 */
export function isNoRecentPostsAnswer(result: { status: string; reason?: string | null }): boolean {
  return result.status === "exhausted" && result.reason === NO_RECENT_POSTS_REASON;
}
