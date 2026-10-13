import { db } from "../db/index.js";
import { leadsCampaigns } from "../db/schema.js";
import { serveNext, type Person, type ReachMethod, type ServiceContext } from "./people-client.js";
import { claimReleasedLead } from "./released-pool.js";
import { AudienceOfferMismatchError, fetchAudienceOfferId } from "./sourcing-origin.js";
import { serveThroughCandidates } from "./candidate-serve.js";
import {
  upsertLeadFromPerson,
  recordEmploymentHistory,
  registerServedEmail,
  upsertContactMethod,
} from "./leads-registry.js";
import { buildFullLead } from "./lead-shape.js";
import { readBuyingSignal, type BuyingSignal } from "./buying-signal.js";
import { readServedPersonId } from "./served-person-id.js";
import { getCurrentGoal } from "./brand-client.js";
import { fetchCampaign } from "./campaign-client.js";
import { pickRetryCandidate } from "./retry-pool.js";
import { checksForWriter, offerChecks, type WriterChecks } from "./writer-checks.js";
import type { SpendIdentity } from "./treg-client.js";
import {
  AUDIENCE_EXHAUSTED_REASON,
  AUDIENCE_NOT_SERVEABLE_REASON,
  NO_AUDIENCE_REASON,
  SERVE_TIMED_OUT_REASON,
  SOURCE_STOCK_EMPTY_REASON,
  AUDIENCE_OFFER_MISMATCH_REASON,
  NO_RECENT_POSTS_REASON,
  isNoRecentPostsAnswer,
  type ServeEmptyReason,
} from "./serve-reasons.js";
import { claimStockedLead, SOURCE_FOUND_STATUS_REASON } from "./source-stock.js";
import { askAudienceFit } from "./audience-fit-client.js";
import { createSourceAudienceJudge } from "./source-stock-belongs.js";
import { isAudienceNotServeableError } from "./people-client.js";

/**
 * What this serve does (src/lib/source-mode.ts, LEADS-ONLY-FUNNEL-CAMPAIGN 2026-10-12):
 *   serve — today: serve `audienceId` for the outreach campaign (retry pool first).
 *   find  — a SOURCE UNIT's own run: find one lead in its audiences (in order), store it under the source campaign
 *           (`status_reason = 'source_found'`), contact nobody. No retry pool (nothing is ever sent from a source),
 *           no Bonus check (writer context, paid when an outreach campaign takes the lead).
 *   stock — an outreach campaign fed by sources that find on their own: retry pool first, then the oldest lead
 *           those sources found that nobody worked yet; nothing is found on demand.
 */
export type PullNextMode =
  | { kind: "serve" }
  | { kind: "find"; audienceIds: string[] }
  | { kind: "stock"; sourceCampaignIds: string[] };

interface PullNextParams {
  orgId: string;
  campaignId: string;
  /** All brand ids this serve is recorded against (leads_campaigns.brand_ids). */
  brandIds: string[];
  /** Primary brand the audience is resolved for (per-brand audiences). */
  brandId: string;
  /** The OUTREACH channel the lead is served for: written on the lead row, never on a run. */
  featureSlug: string;
  /**
   * The feature slug every downstream call of this serve carries (x-feature-slug): the audience's
   * SOURCING origin (src/lib/sourcing-origin.ts), so what the serve buys is labelled as sourcing.
   */
  runFeatureSlug: string;
  /**
   * The campaign every downstream call of this serve carries (x-campaign-id): the ON SOURCE campaign
   * that finds the lead (src/lib/source-campaign.ts), else the outreach campaign. Lead rows, the
   * retry pool and the offer read stay on `campaignId` (the outreach campaign that works the lead).
   */
  runCampaignId?: string;
  parentRunId?: string | null;
  runId?: string | null;
  userId?: string | null;
  workflowSlug?: string;
  activeGoalId?: string | null;
  brandProfileId?: string | null;
  audienceId?: string | null;
  /** Absent = `serve` (today). */
  mode?: PullNextMode;
  /**
   * The contact method(s) the outreach pipe writes on (src/lib/channel-reach.ts). Passed on every fresh serve
   * (human-service `reachableBy`) and applied to every pool (retry, stock, released). Absent = no requirement.
   */
  reachableBy?: ReachMethod[];
  /**
   * The named audience may not be served for this pipe (its origin does not feed the channel): no FRESH serve; the
   * campaign's retry / released pools still drain, then the answer names this reason.
   */
  freshServeRefused?: { reason: ServeEmptyReason; detail: string };
}

interface PullNextResult {
  found: boolean;
  /**
   * Present on every empty answer, absent when a lead was served. Only
   * `audience_exhausted` says a population ran out — see serve-reasons.ts.
   */
  reason?: ServeEmptyReason;
  lead?: {
    leadId: string;
    email: string;
    data: unknown;
    brandIds: string[];
    orgId: string | null;
    userId: string | null;
    apolloPersonId: string | null;
    goal: string | null;
    activeGoalId: string | null;
    brandProfileId: string | null;
    audienceId: string | null;
    /** The buying signal the serve carried, or null. Never derived here. */
    buyingSignal: BuyingSignal | null;
    /**
     * The human-service person this lead is (its `people.id`), when the serve
     * stated one. OMITTED otherwise, never null-filled, never derived from leadId.
     */
    personId?: string;
    /**
     * Every enabled check of the campaign's offer on this lead's company, as the email writer
     * reads it (src/lib/writer-checks.ts): Hard filters read back, Bonus checks run on this serve.
     */
    qualification: WriterChecks;
  };
}

/**
 * Return the next real person to contact for the audience the campaign selected:
 *   1. Use the audience id the campaign passed in (x-audience-id header).
 *      campaign-service owns audience selection per run and propagates it down
 *      the workflow DAG; lead-service does NOT re-rank or re-select.
 *   2. Drain the already-paid pool first: a person this campaign already served,
 *      already paid for, and never handed to the sending vendor. Every serve is
 *      billed and suppressed for three months on the spot, so a downstream failure
 *      after the serve leaves a prospect the brand owns and can never be offered
 *      again by serve-next. See retry-pool.ts.
 *   3. Only when nobody is retryable, ask human-service serve-next for that
 *      audience's next unserved person.
 *   4. Record the person into lead-service silver (leads + leads_campaigns) and
 *      return it in the same FullLead shape the workflow already consumes.
 *
 * lead-service generates NO filters and takes NO provider — human-service owns
 * the audience's canonical filters, provider routing, and dedup/suppression.
 * No audience id (campaign selected none) or an exhausted audience surfaces
 * cleanly as found:false; real errors (serve-next non-2xx, network) fail loud.
 *
 * Every empty answer names WHY it is empty. Only `audience_exhausted` means a
 * population ran out — being told to serve no audience, or running out of time
 * before the look finished, is not evidence about anybody's population, and the
 * caller stops a campaign for good on the strength of that distinction.
 */
export async function pullNext(
  params: PullNextParams,
  signal?: AbortSignal,
): Promise<PullNextResult> {
  if (signal?.aborted) return { found: false, reason: SERVE_TIMED_OUT_REASON };
  const mode: PullNextMode = params.mode ?? { kind: "serve" };

  // A source unit's own run with no audience of its origin: it looked at nobody (never exhaustion).
  if (mode.kind === "find" && mode.audienceIds.length === 0) {
    console.log(
      `[lead-service] pullNext found=false source campaign=${params.campaignId} reason=${NO_AUDIENCE_REASON} brand=${params.brandId} origin=${params.runFeatureSlug}: no active audience of this source`,
    );
    return { found: false, reason: NO_AUDIENCE_REASON };
  }

  // 1. The audience is selected by campaign-service per run and passed in via the
  // x-audience-id header. lead-service does NOT re-rank or re-select. No audience
  // id (campaign selected none) ⟹ clean found:false, no serve, no brand call.
  // (A source unit's own run walks its own audiences, src/lib/source-audiences.ts; a stock serve needs none.)
  const audienceId = mode.kind === "find" ? mode.audienceIds[0] : (params.audienceId ?? null);
  if (!audienceId && mode.kind === "serve") {
    console.log(
      `[lead-service] pullNext found=false campaign=${params.campaignId} reason=${NO_AUDIENCE_REASON} brand=${params.brandId} feature=${params.featureSlug}`,
    );
    // Nothing was looked at: this service does not choose audiences, so an absent
    // x-audience-id means the caller named nobody to serve. NOT exhaustion.
    return { found: false, reason: NO_AUDIENCE_REASON };
  }

  const baseCtx: ServiceContext = {
    orgId: params.orgId,
    userId: params.userId ?? null,
    runId: params.runId ?? null,
    brandId: params.brandId,
    campaignId: params.runCampaignId ?? params.campaignId,
    workflowSlug: params.workflowSlug,
    featureSlug: params.runFeatureSlug,
    activeGoalId: params.activeGoalId ?? undefined,
    brandProfileId: params.brandProfileId ?? undefined,
    audienceId: audienceId ?? undefined,
    ...(params.reachableBy && params.reachableBy.length > 0 ? { reachableBy: params.reachableBy } : {}),
  };

  // 2. The goal belongs to the brand (brands.currentGoal), not the caller — read
  // it from brand-service for attribution/storage. No goal set ⟹ brand-service
  // 404 ⟹ this fails loud.
  //
  // A brand selling SEVERAL offers refuses every brand-scoped read with 409
  // SEVERAL_OFFERS, so the read is scoped to the OFFER the campaign sells: the
  // campaign names exactly one (campaign-service `campaigns.offer_id`), so the
  // offer comes from the campaign row, never guessed. Resolving the campaign is
  // fail-soft with a loud log — campaign-service unreachable must not add a new
  // hard dependency to the serve path — because the goal read itself is the loud
  // guard: without an offer on a multi-offer brand it surfaces the brand-service
  // SEVERAL_OFFERS 409 verbatim, and single-offer brands are byte-identical.
  let offerId: string | null = null;
  try {
    const campaign = await fetchCampaign(params.campaignId, params.orgId, baseCtx);
    offerId = campaign?.offerId ?? null;
  } catch (err) {
    console.warn(
      `[lead-service] campaign offer unresolved for campaign=${params.campaignId} — ` +
        `the goal read falls back to brand scope, which brand-service refuses on a multi-offer brand: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const goal = await getCurrentGoal(params.brandId, params.orgId, baseCtx, offerId);
  const ctx: ServiceContext = { ...baseCtx, goal };
  // The offer's enabled checks, read before anything is bought: the Bonus ones run once a person
  // is served (email verified, handed to the writer next), every one is read back for the writer.
  const checks = await offerChecks(params.orgId, params.brandId, offerId);
  const writerChecks = async (fullLead: Awaited<ReturnType<typeof buildFullLead>>): Promise<WriterChecks> => {
    const identity: SpendIdentity | null = params.runId
      ? {
          orgId: params.orgId,
          userId: params.userId ?? null,
          runId: params.runId,
          brandId: params.brandId,
          campaignId: params.runCampaignId ?? params.campaignId,
          workflowSlug: params.workflowSlug ?? null,
          featureSlug: params.runFeatureSlug,
        }
      : null;
    // A find hands the lead to nobody's writer: only the Hard filters are read back, no Bonus check is paid.
    return checksForWriter(fullLead, mode.kind === "find" ? checks.filter((c) => c.mode !== "mention") : checks, identity);
  };

  if (signal?.aborted) return { found: false, reason: SERVE_TIMED_OUT_REASON };

  // 3. Drain the already-paid pool BEFORE buying anyone new.
  //
  // Every serve is billed and suppressed for three months on the spot, so a person
  // dropped by a downstream failure is a prospect the brand paid for and can no longer
  // reach — `serveNext` will never offer them again. Look at this campaign's own
  // uncontacted serves first: one batched, campaign-scoped email-gateway call decides
  // who was never handed to the vendor, and the winner is claimed atomically so two
  // concurrent runs cannot take the same person. Nobody retryable (or email-gateway
  // unreachable, which is fail-closed) falls through to serveNext exactly as before.
  const retry = mode.kind === "find" ? null : await pickRetryCandidate({
    orgId: params.orgId,
    campaignId: params.campaignId,
    brandId: params.brandId,
    runId: params.runId ?? null,
    parentRunId: params.parentRunId ?? null,
    context: ctx,
    reachableBy: params.reachableBy ?? null,
  });

  if (retry) {
    const retryLead = await buildFullLead(retry.leadId);
    const qualification = await writerChecks(retryLead);
    console.log(
      `[lead-service] pullNext found=true source=retry-pool campaign=${params.campaignId} email=${retry.email} leadId=${retry.leadId} attempt=${retry.retryCount + 1}`,
    );
    return {
      found: true,
      lead: {
        leadId: retry.leadId,
        email: retry.email,
        data: retryLead,
        brandIds: params.brandIds,
        orgId: params.orgId,
        userId: params.userId ?? null,
        apolloPersonId: retryLead.apolloPersonId ?? null,
        goal: retry.goal ?? goal,
        activeGoalId: params.activeGoalId ?? null,
        brandProfileId: params.brandProfileId ?? null,
        // The audience this person was originally served from, when the row carries it.
        audienceId: retry.audienceId ?? audienceId,
        // The signal stored on the original serve — the one that bought this person.
        buyingSignal: retry.buyingSignal,
        // The person stored on the original serve, when it carried one.
        ...(retry.personId ? { personId: retry.personId } : {}),
        qualification,
      },
    };
  }

  if (signal?.aborted) return { found: false, reason: SERVE_TIMED_OUT_REASON };

  // Record the served person into silver and answer. One definition for a serve and a find.
  async function recordServed(served: { person?: Person | null; personId?: unknown }, servedAudienceId: string): Promise<PullNextResult> {
    if (!served.person) throw new Error(`[lead-service] recordServed called without a person (audience=${servedAudienceId})`);
    const person: Person = served.person;
    // Read BEFORE any write: a malformed signal is a producer contract break and must
    // fail the serve loudly rather than half-record it.
    const buyingSignal = readBuyingSignal(person.buyingSignal);
    const personId = readServedPersonId(served.personId);
    if (!person.email) {
      // serve-next promised a contactable person but gave no email — a producer
      // contract violation, not an empty result. Fail loud.
      throw new Error(
        `[lead-service] serve-next returned status=served without an email: audienceId=${servedAudienceId}, campaign=${params.campaignId}`,
      );
    }

    // 5. Record into silver (leads + contact + organization + lifecycle row).
    //
    // A person is ONE identity: when this email already belongs to a lead, THAT
    // lead is the person and the serve is attributed to it. The global
    // one-email-one-lead index means no other lead can ever carry the email, so
    // serving a different lead would leave its delivery status permanently
    // unresolvable — invisible in the dashboard funnel, in outreach counts, and
    // in conversion attribution. `registerServedEmail` returns the owning lead,
    // and fails loud if the email cannot be registered at all.
    const resolvedLeadId = await upsertLeadFromPerson(person, { enriched: true });
    const leadId = await registerServedEmail({
      leadId: resolvedLeadId,
      email: person.email,
      status: person.emailStatus ?? null,
      source: person.provider,
    });
    await recordEmploymentHistory({ leadId, person });
    // The phone the provider holds (crm only): what tells a phone pipe's pools who it can reach.
    if (typeof person.phone === "string" && person.phone.trim().length > 0) {
      const phone = await upsertContactMethod({ leadId, channel: "phone", value: person.phone.trim(), source: person.provider });
      if (!phone.inserted) {
        console.warn(`[lead-service] served phone already belongs to another lead: leadId=${leadId} campaign=${params.campaignId} (not recorded)`);
      }
    }

    await db
      .insert(leadsCampaigns)
      .values({
        leadId,
        campaignId: params.campaignId,
        orgId: params.orgId,
        brandIds: params.brandIds,
        status: "served",
        // A find is the SOURCE's fact (src/lib/source-stock.ts reads it as stock); a serve is the outreach campaign's.
        statusReason: mode.kind === "find" ? SOURCE_FOUND_STATUS_REASON : "served",
        statusDetails: `Served via audience ${servedAudienceId}, email=${person.email}, leadId=${leadId}, campaign=${params.campaignId}`,
        servedAt: new Date(),
        parentRunId: params.parentRunId ?? null,
        runId: params.runId ?? null,
        pushRunId: params.runId ?? null,
        userId: params.userId ?? null,
        workflowSlug: params.workflowSlug ?? null,
        featureSlug: params.featureSlug ?? null,
        goal,
        activeGoalId: params.activeGoalId ?? null,
        brandProfileId: params.brandProfileId ?? null,
        audienceId: servedAudienceId,
        buyingSignal,
        personId,
      })
      .onConflictDoNothing();

    const fullLead = await buildFullLead(leadId);
    const qualification = await writerChecks(fullLead);

    console.log(
      `[lead-service] pullNext found=true campaign=${params.campaignId} audienceId=${servedAudienceId} email=${person.email} leadId=${leadId}`,
    );

    return {
      found: true,
      lead: {
        leadId,
        email: person.email,
        data: fullLead,
        brandIds: params.brandIds,
        orgId: params.orgId,
        userId: params.userId ?? null,
        apolloPersonId: person.providerPersonId,
        goal,
        activeGoalId: params.activeGoalId ?? null,
        brandProfileId: params.brandProfileId ?? null,
        audienceId: servedAudienceId,
        buyingSignal,
        ...(personId ? { personId } : {}),
        qualification,
      },
    };
  }

  // RELEASED: a person another pipe of the brand served and could not reach on ITS channel (src/lib/released-pool.ts),
  // that this pipe can. Paid for once already: taken before buying anyone new.
  if (mode.kind !== "find") {
    const released = await claimReleasedLead({
      orgId: params.orgId,
      campaignId: params.campaignId,
      brandIds: params.brandIds,
      featureSlug: params.featureSlug,
      reachableBy: params.reachableBy ?? [],
      offerId,
      runId: params.runId ?? null,
      parentRunId: params.parentRunId ?? null,
      userId: params.userId ?? null,
      workflowSlug: params.workflowSlug ?? null,
      goal,
      activeGoalId: params.activeGoalId ?? null,
      brandProfileId: params.brandProfileId ?? null,
    });
    if (released) {
      const releasedLead = await buildFullLead(released.leadId);
      const qualification = await writerChecks(releasedLead);
      console.log(
        `[lead-service] pullNext found=true source=released campaign=${params.campaignId} from=${released.releasedFromCampaignId} email=${released.email} leadId=${released.leadId}`,
      );
      return {
        found: true,
        lead: {
          leadId: released.leadId,
          email: released.email,
          data: releasedLead,
          brandIds: params.brandIds,
          orgId: params.orgId,
          userId: params.userId ?? null,
          apolloPersonId: releasedLead.apolloPersonId ?? null,
          goal: released.goal ?? goal,
          activeGoalId: params.activeGoalId ?? null,
          brandProfileId: params.brandProfileId ?? null,
          audienceId: released.audienceId,
          buyingSignal: released.buyingSignal,
          ...(released.personId ? { personId: released.personId } : {}),
          qualification,
        },
      };
    }
  }

  // STOCK: the oldest lead the feeding sources found on their own and nobody worked yet. Never a find on demand.
  if (mode.kind === "stock") {
    const judgeSourceAudience = createSourceAudienceJudge({ orgId: params.orgId, userId: params.userId ?? null, runId: params.runId ?? null });
    const claim = await claimStockedLead({
      orgId: params.orgId,
      sourceCampaignIds: mode.sourceCampaignIds,
      outreachCampaignId: params.campaignId,
      brandIds: params.brandIds,
      featureSlug: params.featureSlug,
      runId: params.runId ?? null,
      parentRunId: params.parentRunId ?? null,
      userId: params.userId ?? null,
      workflowSlug: params.workflowSlug ?? null,
      goal,
      activeGoalId: params.activeGoalId ?? null,
      brandProfileId: params.brandProfileId ?? null,
      reachableBy: params.reachableBy ?? null,
      // A find outside the source's own funnel audiences, origin or offer is not its own (LEAK-1012 part 2); then the
      // audience's owner says whether it still fits now (STILL-FITS-1012). Neither is re-graded here.
      askFit: async ({ sourceCampaignId, ...q }) => {
        const belongs = await judgeSourceAudience(sourceCampaignId, q.audienceId);
        if (!belongs.belongs) return { fits: false, reason: belongs.reason };
        return askAudienceFit({ ...q, brandId: params.brandId }, { orgId: params.orgId, userId: params.userId ?? null, runId: params.runId ?? null });
      },
    });
    const stocked = claim.lead;
    if (!stocked) {
      console.log(
        `[lead-service] pullNext found=false campaign=${params.campaignId} reason=${SOURCE_STOCK_EMPTY_REASON} sources=${mode.sourceCampaignIds.join(",")} setAside=${claim.setAside.length}`,
      );
      return { found: false, reason: SOURCE_STOCK_EMPTY_REASON };
    }
    const stockLead = await buildFullLead(stocked.leadId);
    const qualification = await writerChecks(stockLead);
    console.log(
      `[lead-service] pullNext found=true source=stock campaign=${params.campaignId} sourceCampaign=${stocked.sourceCampaignId} email=${stocked.email} leadId=${stocked.leadId}`,
    );
    return {
      found: true,
      lead: {
        leadId: stocked.leadId,
        email: stocked.email,
        data: stockLead,
        brandIds: params.brandIds,
        orgId: params.orgId,
        userId: params.userId ?? null,
        apolloPersonId: stockLead.apolloPersonId ?? null,
        goal: stocked.goal ?? goal,
        activeGoalId: params.activeGoalId ?? null,
        brandProfileId: params.brandProfileId ?? null,
        audienceId: stocked.audienceId,
        buyingSignal: stocked.buyingSignal,
        ...(stocked.personId ? { personId: stocked.personId } : {}),
        qualification,
      },
    };
  }

  // FIND: walk the source's audiences in order until one serves somebody. Only when EVERY audience was walked and
  // answered nobody left is it `audience_exhausted`; an unfinished look or an audience that cannot be walked yet
  // says so instead.
  if (mode.kind === "find") {
    let notServeable = 0;
    let noRecentPosts = 0;
    for (const candidateAudienceId of mode.audienceIds) {
      if (signal?.aborted) return { found: false, reason: SERVE_TIMED_OUT_REASON };
      const audienceCtx: ServiceContext = { ...ctx, audienceId: candidateAudienceId };
      let served: Awaited<ReturnType<typeof serveNext>>;
      try {
        served = (await serveThroughCandidates(candidateAudienceId, audienceCtx, offerId, signal)) ?? (await serveNext(candidateAudienceId, audienceCtx));
      } catch (err) {
        if (isAudienceNotServeableError(err)) {
          notServeable++;
          continue;
        }
        throw err;
      }
      if (served.status === "pending") {
        console.log(
          `[lead-service] pullNext found=false source campaign=${params.campaignId} reason=${SERVE_TIMED_OUT_REASON} audienceId=${candidateAudienceId} serveNext=pending`,
        );
        return { found: false, reason: SERVE_TIMED_OUT_REASON };
      }
      if (isNoRecentPostsAnswer(served)) {
        noRecentPosts++;
        continue;
      }
      if (served.status === "exhausted" || !served.person) continue;
      return recordServed(served, candidateAudienceId);
    }
    // An audience with nothing to read (competitor pages posted nothing) means the walk did NOT find everyone gone:
    // it wins over the rest. Then an audience that could not be walked; only a full walk-out is exhaustion.
    const reason =
      noRecentPosts > 0 ? NO_RECENT_POSTS_REASON : notServeable > 0 ? AUDIENCE_NOT_SERVEABLE_REASON : AUDIENCE_EXHAUSTED_REASON;
    console.log(
      `[lead-service] pullNext found=false source campaign=${params.campaignId} reason=${reason} audiences=${mode.audienceIds.length} notServeable=${notServeable} noRecentPosts=${noRecentPosts}`,
    );
    return { found: false, reason };
  }

  // The named audience does not feed this pipe (its origin): no fresh serve, the reason says why.
  if (params.freshServeRefused) {
    console.log(
      `[lead-service] pullNext found=false campaign=${params.campaignId} reason=${params.freshServeRefused.reason} audienceId=${audienceId}: ${params.freshServeRefused.detail}`,
    );
    return { found: false, reason: params.freshServeRefused.reason };
  }
  // The named audience belongs to another offer than the one this campaign sells: never served here (owner
  // 2026-10-12). A brand-wide audience (no offer) and an unknown campaign offer pass.
  if (offerId) {
    const audienceOffer = await fetchAudienceOfferId(audienceId as string, params.orgId);
    if (audienceOffer !== null && audienceOffer !== offerId) {
      const mismatch = new AudienceOfferMismatchError(audienceId as string, audienceOffer, offerId);
      console.error(`[lead-service] pullNext found=false campaign=${params.campaignId} reason=${AUDIENCE_OFFER_MISMATCH_REASON}: ${mismatch.message}`);
      return { found: false, reason: AUDIENCE_OFFER_MISMATCH_REASON };
    }
  }

  // 4. Next person of that audience worth paying for. Apollo audiences are served through
  // CANDIDATES: the audience screen and the OFFER's must-pass checks are decided HERE before the
  // reveal is paid (src/lib/candidate-serve.ts). An audience human-service does not serve that
  // way (crm, apify, CRM outreach) answers null and keeps serve-next, screen and all.
  const servedAudienceId = audienceId as string;
  const served = (await serveThroughCandidates(servedAudienceId, ctx, offerId, signal)) ?? (await serveNext(servedAudienceId, ctx));

  // human-service bounds each serve-next call: when its budget runs out mid-walk it
  // answers `pending` with no person, and the next call resumes the walk. That is an
  // unfinished look, never exhaustion — reading it as exhaustion would stop the
  // campaign for good on an audience that still has people.
  if (served.status === "pending") {
    console.log(
      `[lead-service] pullNext found=false campaign=${params.campaignId} reason=${SERVE_TIMED_OUT_REASON} audienceId=${audienceId} serveNext=pending`,
    );
    return { found: false, reason: SERVE_TIMED_OUT_REASON };
  }

  if (isNoRecentPostsAnswer(served)) {
    console.log(
      `[lead-service] pullNext found=false campaign=${params.campaignId} reason=${NO_RECENT_POSTS_REASON} audienceId=${audienceId}`,
    );
    // Nothing to read engagers from yet: not a population that ran out.
    return { found: false, reason: NO_RECENT_POSTS_REASON };
  }

  if (served.status === "exhausted" || !served.person) {
    console.log(
      `[lead-service] pullNext found=false campaign=${params.campaignId} reason=${AUDIENCE_EXHAUSTED_REASON} audienceId=${audienceId}`,
    );
    // The audience was walked and has nobody left — the one empty answer here that
    // is evidence about a population.
    return { found: false, reason: AUDIENCE_EXHAUSTED_REASON };
  }

  return recordServed(served, servedAudienceId);
}

export { leadsCampaigns };
