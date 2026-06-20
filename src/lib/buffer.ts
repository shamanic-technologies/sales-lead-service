import { db } from "../db/index.js";
import { leadsCampaigns } from "../db/schema.js";
import { serveNext, type Person, type ServiceContext } from "./people-client.js";
import {
  upsertLeadFromPerson,
  recordEmploymentHistory,
  upsertContactMethod,
} from "./leads-registry.js";
import { buildFullLead } from "./lead-shape.js";
import { getCurrentGoal } from "./brand-client.js";

interface PullNextParams {
  orgId: string;
  campaignId: string;
  /** All brand ids this serve is recorded against (leads_campaigns.brand_ids). */
  brandIds: string[];
  /** Primary brand the audience is resolved for (per-brand audiences). */
  brandId: string;
  featureSlug: string;
  parentRunId?: string | null;
  runId?: string | null;
  userId?: string | null;
  workflowSlug?: string;
  activeGoalId?: string | null;
  brandProfileId?: string | null;
  customerPersonaId?: string | null;
  audienceId?: string | null;
}

interface PullNextResult {
  found: boolean;
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
    customerPersonaId: string | null;
    audienceId: string | null;
  };
}

/**
 * Return the next real person to contact for the audience the campaign selected:
 *   1. Use the audience id the campaign passed in (x-audience-id header).
 *      campaign-service owns audience selection per run and propagates it down
 *      the workflow DAG; lead-service does NOT re-rank or re-select.
 *   2. Ask human-service serve-next for that audience's next unserved person.
 *   3. Record the person into lead-service silver (leads + leads_campaigns) and
 *      return it in the same FullLead shape the workflow already consumes.
 *
 * lead-service generates NO filters and takes NO provider — human-service owns
 * the audience's canonical filters, provider routing, and dedup/suppression.
 * No audience id (campaign selected none) or an exhausted audience surfaces
 * cleanly as found:false; real errors (serve-next non-2xx, network) fail loud.
 */
export async function pullNext(
  params: PullNextParams,
  signal?: AbortSignal,
): Promise<PullNextResult> {
  if (signal?.aborted) return { found: false };

  // 1. The audience is selected by campaign-service per run and passed in via the
  // x-audience-id header. lead-service does NOT re-rank or re-select. No audience
  // id (campaign selected none) ⟹ clean found:false, no serve, no brand call.
  const audienceId = params.audienceId ?? null;
  if (!audienceId) {
    console.log(
      `[lead-service] pullNext found=false campaign=${params.campaignId} reason=no_audience brand=${params.brandId} feature=${params.featureSlug}`,
    );
    return { found: false };
  }

  const baseCtx: ServiceContext = {
    orgId: params.orgId,
    userId: params.userId ?? null,
    runId: params.runId ?? null,
    brandId: params.brandId,
    campaignId: params.campaignId,
    workflowSlug: params.workflowSlug,
    featureSlug: params.featureSlug,
    activeGoalId: params.activeGoalId ?? undefined,
    brandProfileId: params.brandProfileId ?? undefined,
    customerPersonaId: params.customerPersonaId ?? undefined,
    audienceId,
  };

  // 2. The goal belongs to the brand (brands.currentGoal), not the caller — read
  // it from brand-service for attribution/storage. No goal set ⟹ brand-service
  // 404 ⟹ this fails loud.
  const goal = await getCurrentGoal(params.brandId, params.orgId, baseCtx);
  const ctx: ServiceContext = { ...baseCtx, goal };

  if (signal?.aborted) return { found: false };

  // 3. Next unserved person of that audience (human-service owns filters/provider/dedup).
  const served = await serveNext(audienceId, ctx);

  if (served.status === "exhausted" || !served.person) {
    console.log(
      `[lead-service] pullNext found=false campaign=${params.campaignId} reason=exhausted audienceId=${audienceId}`,
    );
    return { found: false };
  }

  const person: Person = served.person;
  if (!person.email) {
    // serve-next promised a contactable person but gave no email — a producer
    // contract violation, not an empty result. Fail loud.
    throw new Error(
      `[lead-service] serve-next returned status=served without an email: audienceId=${audienceId}, campaign=${params.campaignId}`,
    );
  }

  // 4. Record into silver (leads + organization + contact + lifecycle row).
  const leadId = await upsertLeadFromPerson(person, { enriched: true });
  await recordEmploymentHistory({ leadId, person });

  const contact = await upsertContactMethod({
    leadId,
    channel: "email",
    value: person.email,
    status: person.emailStatus ?? null,
    source: person.provider,
  });
  if (!contact.inserted) {
    console.warn(
      `[lead-service] serve-next email already attached to another lead, serving anyway: email=${person.email}, leadId=${leadId}, audienceId=${audienceId}, campaign=${params.campaignId}`,
    );
  }

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
      customerPersonaId: params.customerPersonaId ?? null,
      audienceId: audienceId,
    })
    .onConflictDoNothing();

  const fullLead = await buildFullLead(leadId);

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
      customerPersonaId: params.customerPersonaId ?? null,
      audienceId: audienceId,
    },
  };
}

export { leadsCampaigns };
