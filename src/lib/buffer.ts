import { db } from "../db/index.js";
import { leadsCampaigns } from "../db/schema.js";
import { serveNext, type Person, type ServiceContext } from "./people-client.js";
import { serveThroughCandidates } from "./candidate-serve.js";
import {
  upsertLeadFromPerson,
  recordEmploymentHistory,
  registerServedEmail,
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
  NO_AUDIENCE_REASON,
  SERVE_TIMED_OUT_REASON,
  type ServeEmptyReason,
} from "./serve-reasons.js";

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

  // 1. The audience is selected by campaign-service per run and passed in via the
  // x-audience-id header. lead-service does NOT re-rank or re-select. No audience
  // id (campaign selected none) ⟹ clean found:false, no serve, no brand call.
  const audienceId = params.audienceId ?? null;
  if (!audienceId) {
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
    audienceId,
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
    return checksForWriter(fullLead, checks, identity);
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
  const retry = await pickRetryCandidate({
    orgId: params.orgId,
    campaignId: params.campaignId,
    brandId: params.brandId,
    runId: params.runId ?? null,
    parentRunId: params.parentRunId ?? null,
    context: ctx,
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

  // 4. Next person of that audience worth paying for. Apollo audiences are served through
  // CANDIDATES: the audience screen and the OFFER's must-pass checks are decided HERE before the
  // reveal is paid (src/lib/candidate-serve.ts). An audience human-service does not serve that
  // way (crm, apify, CRM outreach) answers null and keeps serve-next, screen and all.
  const served = (await serveThroughCandidates(audienceId, ctx, offerId, signal)) ?? (await serveNext(audienceId, ctx));

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

  if (served.status === "exhausted" || !served.person) {
    console.log(
      `[lead-service] pullNext found=false campaign=${params.campaignId} reason=${AUDIENCE_EXHAUSTED_REASON} audienceId=${audienceId}`,
    );
    // The audience was walked and has nobody left — the one empty answer here that
    // is evidence about a population.
    return { found: false, reason: AUDIENCE_EXHAUSTED_REASON };
  }

  const person: Person = served.person;
  // Read BEFORE any write: a malformed signal is a producer contract break and must
  // fail the serve loudly rather than half-record it.
  const buyingSignal = readBuyingSignal(person.buyingSignal);
  const personId = readServedPersonId(served.personId);
  if (!person.email) {
    // serve-next promised a contactable person but gave no email — a producer
    // contract violation, not an empty result. Fail loud.
    throw new Error(
      `[lead-service] serve-next returned status=served without an email: audienceId=${audienceId}, campaign=${params.campaignId}`,
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

  await db
    .insert(leadsCampaigns)
    .values({
      leadId,
      campaignId: params.campaignId,
      orgId: params.orgId,
      brandIds: params.brandIds,
      status: "served",
      statusReason: "served",
      statusDetails: `Served via audience ${audienceId}, email=${person.email}, leadId=${leadId}, campaign=${params.campaignId}`,
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
      audienceId: audienceId,
      buyingSignal,
      personId,
    })
    .onConflictDoNothing();

  const fullLead = await buildFullLead(leadId);
  const qualification = await writerChecks(fullLead);

  console.log(
    `[lead-service] pullNext found=true campaign=${params.campaignId} audienceId=${audienceId} email=${person.email} leadId=${leadId}`,
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
      audienceId: audienceId,
      buyingSignal,
      ...(personId ? { personId } : {}),
      qualification,
    },
  };
}

export { leadsCampaigns };
