import { sql } from "drizzle-orm";
import { resolveServedIdentity } from "./serve-identity.js";
import { db } from "../db/index.js";
import { leadsCampaigns } from "../db/schema.js";
import { readEmailVerdict, type EmailPolicy, type PoolEmailPolicy } from "./email-policy.js";
import { clearEmptyAnswer, recordEmptyAnswer } from "./source-audience-walk.js";
import { serveNext, type Person, type ReachMethod, type ServiceContext, type StepFilter } from "./people-client.js";
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
import { pickRetryCandidate, type PoolSender } from "./retry-pool.js";
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
  CONTACTED_PROSPECTS_NONE_OWED_REASON,
  RECENTLY_EMAILED_REASON,
  isNoRecentPostsAnswer,
  type ServeEmptyReason,
} from "./serve-reasons.js";
import { claimStockedLead, SOURCE_FOUND_STATUS_REASON } from "./source-stock.js";
import { claimContactedProspect, handoutOfSourceRow, loadProspectFollowupVerdicts } from "./prospect-followup.js";
import type { RelationshipScope } from "./reach-sql.js";
import type { RelationshipPolicy } from "./relationship-tags.js";
import { askAudienceFit } from "./audience-fit-client.js";
import type { RecentlyEmailedScope, RecentlyEmailedWindow } from "./recently-emailed-sql.js";
import { assertRecentlyEmailedReadable, leadRecentlyEmailed } from "./recently-emailed.js";
import { createSourceAudienceJudge } from "./source-stock-belongs.js";
import { noteLeadFound } from "./outcome-triggers.js";
import { isAudienceNotServeableError } from "./people-client.js";
import { prepareNamedServe, type NamedLeadRequest } from "./named-lead-serve.js";

/**
 * What this serve does (src/lib/source-mode.ts, LEADS-ONLY-FUNNEL-CAMPAIGN 2026-10-12):
 *   serve — today: serve `audienceId` for the outreach campaign (retry pool first).
 *   find  — a SOURCE UNIT's own run: find one lead in its audiences (in order), store it under the source campaign
 *           (`status_reason = 'source_found'`), contact nobody. No retry pool (nothing is ever sent from a source),
 *           no Bonus check (writer context, paid when an outreach campaign takes the lead).
 *   stock — an outreach campaign fed by sources that find on their own: retry pool first, then the oldest lead
 *           those sources found that nobody worked yet; nothing is found on demand.
 *   find_contacted — a source unit's own run whose lead strategy is the brand's CONTACTED PURE PROSPECTS
 *           (body `population: "contacted_pure_prospects"`, NEVER-NO-FOLLOWUP-1014, src/lib/prospect-followup.ts):
 *           like `find`, but from people the brand already emailed, each at most once per brand; nothing is bought.
 *   named — the run's trigger occurrence NAMES its person (body `namedLead`, LEAD-NAMED-SERVE-1015,
 *           src/lib/named-lead-serve.ts): exactly that person, filed on this campaign, or a named refusal. No pool, no
 *           audience, nothing bought but the one enrichment of a person known only by an email.
 */
export type PullNextMode =
  | { kind: "serve" }
  | { kind: "named"; named: NamedLeadRequest }
  | { kind: "find"; audienceIds: string[] }
  | { kind: "find_contacted" }
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
   * Who states whether a served person of THIS campaign was contacted (retry-pool.ts `poolSenderOf`, from the channel's
   * own contact methods): absent = email-gateway (today); `channel` = the non-email sender's record (crm-service).
   */
  poolSender?: PoolSender;
  /**
   * Which verified emails the workflow accepts (src/lib/email-policy.ts). Sent to human-service on every fresh serve
   * and applied to every pool. Absent = valid only (today, and nothing on the wire).
   */
  acceptedEmails?: EmailPolicy;
  /**
   * The pipe's relationship policy (src/lib/relationship-tags.ts, RELATIONSHIP-TAGS-1014): forwarded to human-service on
   * every fresh serve and applied to every pool. Absent = nothing asked (today).
   */
  relationships?: RelationshipPolicy;
  /**
   * The pipe's CRM funnel-step filter (CRM-WARM-NURTURE-1015), opaque: forwarded verbatim on every fresh serve (and its
   * candidates walk) and on every still-fits question at stock handover. The RELEASED pool is skipped when it is stated
   * (its people were served under another pipe's rules and nothing here can vouch for their steps).
   */
  stepFilter?: StepFilter;
  /**
   * Tactic "Fresh contacts only" (src/lib/recently-emailed-sql.ts, FRESH-CONTACTS-1015): nobody the brand emailed inside
   * the window is handed out. Every pool filters them (they stay where they are); a fresh serve that bought one keeps
   * them filed under this campaign and buys the next, up to FRESH_SERVE_ATTEMPTS. Absent = nothing asked (today).
   */
  excludeEmailedWithin?: RecentlyEmailedWindow;
  /**
   * The named audience may not be served for this pipe (its origin does not feed the channel): no FRESH serve; the
   * campaign's retry / released pools still drain, then the answer names this reason.
   */
  freshServeRefused?: { reason: ServeEmptyReason; detail: string };
}

/** How many people one call may buy on a fresh serve when each was emailed by the brand inside the asked window. */
export const FRESH_SERVE_ATTEMPTS = 5;

interface PullNextResult {
  found: boolean;
  /**
   * Present on every empty answer, absent when a lead was served. Only
   * `audience_exhausted` says a population ran out — see serve-reasons.ts.
   */
  reason?: ServeEmptyReason;
  /** A named serve's refusal only (src/lib/named-lead-serve.ts): one sentence a client can read. */
  message?: string;
  /** A named serve's empty answer only: true = a retry cannot change it, false = wait and ask again. */
  final?: boolean;
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
  // A source unit's own run: stores what it finds under itself, contacts nobody (no retry/released pool, no Bonus).
  const finding = mode.kind === "find" || mode.kind === "find_contacted";

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
    ...(params.acceptedEmails ? { acceptedEmails: params.acceptedEmails } : {}),
    ...(params.relationships ? { relationships: params.relationships } : {}),
    ...(params.stepFilter ? { stepFilter: params.stepFilter } : {}),
  };
  // What the pools filter on: the pipe's own word, else, for a pipe serving a source's stock, the person as the source
  // found them (CATCHALL-SOURCE-OWNS-1014: which emails a source keeps is the source pipe's strategy; a pipe stating
  // nothing makes no email choice). Any other pipe stating nothing keeps valid only.
  const poolEmails: PoolEmailPolicy | null = params.acceptedEmails ?? (mode.kind === "stock" ? "as_found" : null);
  const relationships: RelationshipScope | null = params.relationships
    ? { policy: params.relationships, orgId: params.orgId, brandIds: params.brandIds }
    : null;
  const recentlyEmailed: RecentlyEmailedScope | null = params.excludeEmailedWithin
    ? { window: params.excludeEmailedWithin, brandIds: params.brandIds }
    : null;
  // Who the brand emailed is read off the copy of instantly-service's facts: a copy still filling cannot say (fail loud).
  if (recentlyEmailed) await assertRecentlyEmailedReadable();

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
    return checksForWriter(fullLead, finding ? checks.filter((c) => c.mode !== "mention") : checks, identity);
  };

  if (signal?.aborted) return { found: false, reason: SERVE_TIMED_OUT_REASON };

  // NAMED: the person the run's occurrence names, on this campaign, or why not. Never another person.
  if (mode.kind === "named") {
    const decision = await prepareNamedServe({
      orgId: params.orgId,
      brandId: params.brandId,
      campaignId: params.campaignId,
      named: mode.named,
      sender: params.poolSender ?? "email",
      runId: params.runId ?? null,
      parentRunId: params.parentRunId ?? null,
      context: { userId: params.userId ?? null, workflowSlug: params.workflowSlug ?? null, featureSlug: params.runFeatureSlug },
    });
    if (!decision.ok) {
      console.log(
        `[lead-service] pullNext found=false named campaign=${params.campaignId} lead=${mode.named.leadId} event=${mode.named.triggerEventId} reason=${decision.reason} final=${decision.final}`,
      );
      return { found: false, reason: decision.reason, message: decision.message, final: decision.final };
    }
    const namedLead = await buildFullLead(mode.named.leadId);
    const qualification = await writerChecks(namedLead);
    const [stored] = (await db.execute(sql`
      SELECT audience_id::text AS audience_id, buying_signal, person_id::text AS person_id, goal
      FROM leads_campaigns WHERE id = ${decision.leadCampaignId}::uuid
    `)) as unknown as Array<{ audience_id: string | null; buying_signal: unknown; person_id: string | null; goal: string | null }>;
    console.log(
      `[lead-service] pullNext found=true source=named campaign=${params.campaignId} lead=${mode.named.leadId} event=${mode.named.triggerEventId}`,
    );
    return {
      found: true,
      lead: {
        leadId: mode.named.leadId,
        email: decision.email,
        data: namedLead,
        brandIds: params.brandIds,
        orgId: params.orgId,
        userId: params.userId ?? null,
        apolloPersonId: namedLead.apolloPersonId ?? null,
        goal: stored?.goal ?? goal,
        activeGoalId: params.activeGoalId ?? null,
        brandProfileId: params.brandProfileId ?? null,
        audienceId: stored?.audience_id ?? null,
        buyingSignal: readBuyingSignal(stored?.buying_signal ?? null),
        ...(stored?.person_id ? { personId: stored.person_id } : {}),
        qualification,
      },
    };
  }

  // 3. Drain the already-paid pool BEFORE buying anyone new.
  //
  // Every serve is billed and suppressed for three months on the spot, so a person
  // dropped by a downstream failure is a prospect the brand paid for and can no longer
  // reach — `serveNext` will never offer them again. Look at this campaign's own
  // uncontacted serves first: one batched, campaign-scoped email-gateway call decides
  // who was never handed to the vendor, and the winner is claimed atomically so two
  // concurrent runs cannot take the same person. Nobody retryable (or email-gateway
  // unreachable, which is fail-closed) falls through to serveNext exactly as before.
  const retry = finding ? null : await pickRetryCandidate({
    orgId: params.orgId,
    campaignId: params.campaignId,
    brandId: params.brandId,
    runId: params.runId ?? null,
    parentRunId: params.parentRunId ?? null,
    context: ctx,
    reachableBy: params.reachableBy ?? null,
    acceptedEmails: poolEmails,
    relationships,
    recentlyEmailed,
    ...(params.poolSender ? { sender: params.poolSender } : {}),
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
  async function recordServed(served: { person?: Person | null; personId?: unknown; emailVerdict?: unknown }, servedAudienceId: string): Promise<PullNextResult> {
    if (!served.person) throw new Error(`[lead-service] recordServed called without a person (audience=${servedAudienceId})`);
    const person: Person = served.person;
    // Read BEFORE any write: a malformed signal is a producer contract break and must
    // fail the serve loudly rather than half-record it.
    const buyingSignal = readBuyingSignal(person.buyingSignal);
    const personId = readServedPersonId(served.personId);
    const verificationVerdict = readEmailVerdict(served.emailVerdict);
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
    // Who the person is and where they work, from their owners (serve-identity.ts): a known human at a
    // new company lands on a NEW lead. null (an owner did not answer) = today's email-first pick.
    const identity = await resolveServedIdentity(person);
    const resolvedLeadId = await upsertLeadFromPerson(person, { enriched: true, identity });
    const leadId = await registerServedEmail({
      leadId: resolvedLeadId,
      email: person.email,
      status: person.emailStatus ?? null,
      source: person.provider,
      ...(verificationVerdict ? { verificationVerdict } : {}),
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

    // The person was FOUND for this brand and offer: its `lead_found` outcome trigger rings campaign-service's door
    // once (outcome-triggers.ts, EVERY-OUTCOME-FIRES-1015). Not awaited: it never blocks, slows or fails the serve.
    noteLeadFound({ orgId: params.orgId, brandId: params.brandId, leadId, email: person.email, campaignId: params.campaignId, offerId });

    // Fresh contacts only: a person the brand emailed inside the window is not handed out. Already bought and filed
    // above, so nothing is lost: this campaign's paid pool (or the source's stock) hands them out later, filtered the
    // same way. Checked before the Bonus checks are paid.
    if (recentlyEmailed && (await leadRecentlyEmailed(leadId, recentlyEmailed))) {
      console.log(
        `[lead-service] pullNext skipped campaign=${params.campaignId} audienceId=${servedAudienceId} leadId=${leadId} reason=${RECENTLY_EMAILED_REASON} window=${recentlyEmailed.window}: kept filed under the campaign`,
      );
      return { found: false, reason: RECENTLY_EMAILED_REASON };
    }

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
  // A pipe stating a step filter never takes a released person: no crm-service answer about their steps here.
  if (!finding && !params.stepFilter) {
    const released = await claimReleasedLead({
      orgId: params.orgId,
      campaignId: params.campaignId,
      brandIds: params.brandIds,
      featureSlug: params.featureSlug,
      reachableBy: params.reachableBy ?? [],
      acceptedEmails: poolEmails,
      relationships,
      recentlyEmailed,
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

  // CONTACTED PURE PROSPECTS: the brand's own contacted people still owed a follow-up, each once per brand ever.
  if (mode.kind === "find_contacted") {
    const find = await claimContactedProspect({
      orgId: params.orgId,
      brandId: params.brandId,
      brandIds: params.brandIds,
      sourceCampaignId: params.campaignId,
      featureSlug: params.featureSlug,
      runId: params.runId ?? null,
      parentRunId: params.parentRunId ?? null,
      userId: params.userId ?? null,
      workflowSlug: params.workflowSlug ?? null,
      goal,
      activeGoalId: params.activeGoalId ?? null,
      brandProfileId: params.brandProfileId ?? null,
      reachableBy: params.reachableBy ?? null,
      // Nothing is bought: the people were already emailed, so a source stating no email choice takes them as found.
      acceptedEmails: params.acceptedEmails ?? "as_found",
      recentlyEmailed,
      signal,
    });
    if (!find) {
      if (signal?.aborted) return { found: false, reason: SERVE_TIMED_OUT_REASON };
      console.log(
        `[lead-service] pullNext found=false source campaign=${params.campaignId} reason=${CONTACTED_PROSPECTS_NONE_OWED_REASON} brand=${params.brandId}`,
      );
      return { found: false, reason: CONTACTED_PROSPECTS_NONE_OWED_REASON };
    }
    const foundLead = await buildFullLead(find.leadId);
    const qualification = await writerChecks(foundLead);
    console.log(
      `[lead-service] pullNext found=true source=contacted-prospects campaign=${params.campaignId} email=${find.email} leadId=${find.leadId} row=${find.leadCampaignId}`,
    );
    return {
      found: true,
      lead: {
        leadId: find.leadId,
        email: find.email,
        data: foundLead,
        brandIds: params.brandIds,
        orgId: params.orgId,
        userId: params.userId ?? null,
        apolloPersonId: foundLead.apolloPersonId ?? null,
        goal,
        activeGoalId: params.activeGoalId ?? null,
        brandProfileId: params.brandProfileId ?? null,
        audienceId: null,
        buyingSignal: null,
        qualification,
      },
    };
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
      acceptedEmails: poolEmails,
      relationships,
      recentlyEmailed,
      // A find outside the source's own funnel audiences, origin or offer is not its own (LEAK-1012 part 2); then the
      // audience's owner says whether it still fits now (STILL-FITS-1012). Neither is re-graded here.
      askFit: async ({ sourceCampaignId, ...q }) => {
        const belongs = await judgeSourceAudience(sourceCampaignId, q.audienceId);
        if (!belongs.belongs) return { fits: false, reason: belongs.reason };
        return askAudienceFit({ ...q, brandId: params.brandId, ...(params.stepFilter ? { stepFilter: params.stepFilter } : {}) }, { orgId: params.orgId, userId: params.userId ?? null, runId: params.runId ?? null });
      },
      // A contacted pure prospect (no audience): still owed a prospect follow-up now? Same verdict a writer reads.
      askStillOwed: async (sourceRowId) => {
        const handout = await handoutOfSourceRow(sourceRowId);
        if (!handout) return null;
        const verdict = (
          await loadProspectFollowupVerdicts({ ...handout, leadIds: [handout.leadId], context: { userId: params.userId ?? null, runId: params.runId ?? null } })
        ).get(handout.leadId);
        if (!verdict) throw new Error(`[lead-service] no prospect follow-up verdict for lead ${handout.leadId}`);
        if (verdict.kind === "owed") return { fits: true };
        // Not yet: released (the source finds them again once owed), never consumed. Stop: set aside for good.
        if (verdict.kind === "not_yet") return { fits: false, release: true, reason: `not yet owed a prospect follow-up (${verdict.reasons.join(", ")}): released` };
        return { fits: false, reason: `no longer owed a prospect follow-up: ${verdict.reasons.join(", ")}` };
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
    let recentlyEmailedHits = 0;
    for (const candidateAudienceId of mode.audienceIds) {
      const audienceCtx: ServiceContext = { ...ctx, audienceId: candidateAudienceId };
      const walked = { sourceCampaignId: params.campaignId, audienceId: candidateAudienceId, acceptedEmails: params.acceptedEmails };
      // The same audience is asked again only after a person emailed recently (fresh contacts only).
      for (;;) {
        if (signal?.aborted) return { found: false, reason: SERVE_TIMED_OUT_REASON };
        let served: Awaited<ReturnType<typeof serveNext>>;
        try {
          served = (await serveThroughCandidates(candidateAudienceId, audienceCtx, offerId, signal)) ?? (await serveNext(candidateAudienceId, audienceCtx));
        } catch (err) {
          if (isAudienceNotServeableError(err)) {
            notServeable++;
            await recordEmptyAnswer({ ...walked, reason: "not_serveable" });
            break;
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
          await recordEmptyAnswer({ ...walked, reason: "no_recent_posts" });
          break;
        }
        if (served.status === "exhausted" || !served.person) {
          await recordEmptyAnswer({ ...walked, reason: "exhausted" });
          break;
        }
        await clearEmptyAnswer(walked);
        const result = await recordServed(served, candidateAudienceId);
        if (result.found || result.reason !== RECENTLY_EMAILED_REASON) return result;
        if (++recentlyEmailedHits >= FRESH_SERVE_ATTEMPTS) return result;
      }
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
  // Fresh contacts only: a person the brand emailed recently stays filed under the campaign, the next one is bought.
  for (let attempt = 1; ; attempt++) {
    const result = await serveFresh();
    if (result.found || result.reason !== RECENTLY_EMAILED_REASON || attempt >= FRESH_SERVE_ATTEMPTS) return result;
    if (signal?.aborted) return { found: false, reason: SERVE_TIMED_OUT_REASON };
  }

  async function serveFresh(): Promise<PullNextResult> {
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
}

export { leadsCampaigns };
