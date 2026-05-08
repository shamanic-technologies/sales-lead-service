import { eq, and, count } from "drizzle-orm";
import { db, sql as pgSql } from "../db/index.js";
import { leadsCampaigns, leadContactMethods, leads } from "../db/schema.js";
import { TARGET_BUFFER_SIZE } from "../config.js";
import {
  apolloFetchPage,
  apolloEnrich,
  type ApolloPersonResult,
  type ApolloSearchParams,
} from "./apollo-client.js";
import {
  upsertLeadFromPerson,
  recordEmploymentHistory,
  upsertContactMethod,
  leadHasEmail,
  getPrimaryEmail,
} from "./leads-registry.js";
import {
  checkContacted,
  isAlreadyServedForBrand,
  checkRaceWindow,
} from "./dedup.js";
import {
  getCurrentStrategy,
  advanceStrategyOrGenerate,
  type StrategyContext,
} from "./strategy-generator.js";
import { fetchCampaign } from "./campaign-client.js";
import { extractBrandFields } from "./brand-client.js";

const VALID_EMAIL_STATUSES = new Set(["verified", "extrapolated"]);

/** TTL for re-enriching a lead. */
const CACHE_TTL_EMAIL_FOUND_MS = 6 * 30 * 24 * 60 * 60 * 1000;
const CACHE_TTL_NO_EMAIL_MS = 1 * 24 * 60 * 60 * 1000;

function isCacheFresh(enrichedAt: Date | null, hasEmail: boolean): boolean {
  if (!enrichedAt) return false;
  const ttl = hasEmail ? CACHE_TTL_EMAIL_FOUND_MS : CACHE_TTL_NO_EMAIL_MS;
  return Date.now() - enrichedAt.getTime() < ttl;
}

async function bufferedCount(orgId: string, campaignId: string): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(leadsCampaigns)
    .where(
      and(
        eq(leadsCampaigns.orgId, orgId),
        eq(leadsCampaigns.campaignId, campaignId),
        eq(leadsCampaigns.status, "buffered"),
      ),
    );
  return row?.c ?? 0;
}

async function buildStrategyContext(params: {
  orgId: string;
  campaignId: string;
  brandIdCsv: string;
  pushRunId?: string | null;
  userId?: string | null;
  workflowSlug?: string;
  featureSlug?: string;
}): Promise<StrategyContext> {
  const serviceContext = {
    userId: params.userId ?? undefined,
    runId: params.pushRunId ?? undefined,
    campaignId: params.campaignId,
    brandId: params.brandIdCsv,
    workflowSlug: params.workflowSlug,
    featureSlug: params.featureSlug,
  };

  const [campaign, brandFields] = await Promise.all([
    fetchCampaign(params.campaignId, params.orgId, serviceContext),
    extractBrandFields(
      [
        { key: "brand_name", description: "The brand's display name" },
        { key: "elevator_pitch", description: "A short elevator pitch describing the brand" },
        { key: "industry", description: "The brand's primary industry vertical" },
        { key: "target_geography", description: "Priority geographic markets for outreach" },
        { key: "ideal_lead_type", description: "Type of leads to target" },
        { key: "target_job_titles", description: "Job titles to prioritize in outreach" },
        { key: "offerings", description: "Key products or services the brand offers" },
      ],
      params.orgId,
      serviceContext,
    ),
  ]);

  const lines: string[] = [];
  if (campaign?.targetAudience) lines.push(`Campaign target audience: ${campaign.targetAudience}`);
  if (campaign?.targetOutcome) lines.push(`Campaign target outcome: ${campaign.targetOutcome}`);
  if (campaign?.valueForTarget) lines.push(`Campaign value for target: ${campaign.valueForTarget}`);
  const featureInputs = campaign?.featureInputs;
  if (featureInputs && Object.keys(featureInputs).length > 0) {
    lines.push(`Campaign featureInputs: ${JSON.stringify(featureInputs)}`);
  }
  if (brandFields) {
    for (const field of brandFields) {
      if (field.value != null) {
        const label = field.key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        const value = typeof field.value === "string" ? field.value : JSON.stringify(field.value);
        lines.push(`${label}: ${value}`);
      }
    }
  }

  return {
    orgId: params.orgId,
    userId: params.userId ?? null,
    runId: params.pushRunId ?? null,
    campaignId: params.campaignId,
    brandId: params.brandIdCsv,
    workflowSlug: params.workflowSlug,
    featureSlug: params.featureSlug,
    brandCampaignDescription: lines.join("\n"),
  };
}

interface IngestParams {
  orgId: string;
  campaignId: string;
  brandIds: string[];
  pushRunId?: string | null;
  userId?: string | null;
  workflowSlug?: string;
  featureSlug?: string;
}

/**
 * Insert one Apollo person into the schema:
 *   - upsert leads (by apolloPersonId)
 *   - upsert organizations + employment history
 *   - upsert email contact method (when present)
 *   - insert leads_campaigns row (status='buffered')
 * Returns true when a NEW leads_campaigns row was inserted (i.e. we added to buffer).
 */
async function ingestPerson(person: ApolloPersonResult, params: IngestParams, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  if (!person.id) return false;

  const leadId = await upsertLeadFromPerson(person, { enriched: false });
  if (signal?.aborted) return false;

  await recordEmploymentHistory({ leadId, person });
  if (signal?.aborted) return false;

  if (person.email) {
    await upsertContactMethod({
      leadId,
      channel: "email",
      value: person.email,
      status: person.emailStatus ?? null,
      source: "apollo",
    });
  }
  if (signal?.aborted) return false;

  // Idempotent: already a leads_campaigns row for (lead, campaign)? Skip insert.
  const inserted = await db
    .insert(leadsCampaigns)
    .values({
      leadId,
      campaignId: params.campaignId,
      orgId: params.orgId,
      brandIds: params.brandIds,
      status: "buffered",
      pushRunId: params.pushRunId ?? null,
      userId: params.userId ?? null,
      workflowSlug: params.workflowSlug ?? null,
      featureSlug: params.featureSlug ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: leadsCampaigns.id });

  return inserted.length > 0;
}

export async function topUpApolloLeadBuffer(params: IngestParams, signal?: AbortSignal): Promise<{ filled: number }> {
  const brandIdCsv = params.brandIds.join(",");
  const ctx = await buildStrategyContext({
    orgId: params.orgId,
    campaignId: params.campaignId,
    brandIdCsv,
    pushRunId: params.pushRunId,
    userId: params.userId,
    workflowSlug: params.workflowSlug,
    featureSlug: params.featureSlug,
  });

  let totalInserted = 0;
  let freshStrategy = true;
  let activeStrategy: ApolloSearchParams | null = null;

  while (!signal?.aborted) {
    const buffered = await bufferedCount(params.orgId, params.campaignId);
    if (buffered + totalInserted >= TARGET_BUFFER_SIZE) {
      return { filled: totalInserted };
    }

    if (!activeStrategy) {
      const current = await getCurrentStrategy(ctx);
      if ("exhausted" in current) {
        console.log(
          `[lead-service] topUp exhausted campaign=${params.campaignId} reason=${current.reason}`,
        );
        return { filled: totalInserted };
      }
      activeStrategy = current.strategy;
      freshStrategy = true;
    }

    const page = await apolloFetchPage({
      campaignId: params.campaignId,
      brandId: brandIdCsv,
      searchParams: freshStrategy ? activeStrategy : undefined,
      runId: params.pushRunId ?? null,
      orgId: params.orgId,
      userId: params.userId ?? null,
      workflowSlug: params.workflowSlug,
      featureSlug: params.featureSlug,
    });
    freshStrategy = false;

    let pageInserted = 0;
    for (const person of page.people) {
      if (signal?.aborted) break;
      const ok = await ingestPerson(person, params, signal);
      if (ok) pageInserted++;
    }
    totalInserted += pageInserted;

    if (page.done || page.people.length === 0) {
      const next = await advanceStrategyOrGenerate(ctx);
      if ("exhausted" in next) {
        console.log(
          `[lead-service] topUp strategies exhausted campaign=${params.campaignId} reason=${next.reason}`,
        );
        return { filled: totalInserted };
      }
      activeStrategy = next.strategy;
      freshStrategy = true;
    }
  }

  return { filled: totalInserted };
}

interface ClaimedRow {
  leadCampaignId: string;
  leadId: string;
  apolloPersonId: string | null;
  enrichedAt: Date | null;
  hasEmail: boolean;
  primaryEmail: string | null;
  primaryEmailStatus: string | null;
}

async function claimNextLeadCampaign(orgId: string, campaignId: string): Promise<ClaimedRow | null> {
  const claimed = await pgSql<{
    id: string;
    lead_id: string;
  }[]>`
    UPDATE leads_campaigns
    SET status = 'claimed', updated_at = NOW()
    WHERE id = (
      SELECT id FROM leads_campaigns
      WHERE org_id = ${orgId}
        AND campaign_id = ${campaignId}
        AND status = 'buffered'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, lead_id
  `;
  if (claimed.length === 0) return null;
  const { id: leadCampaignId, lead_id: leadId } = claimed[0];

  const lead = await db.query.leads.findFirst({
    where: eq(leads.id, leadId),
  });
  const primary = await getPrimaryEmail(leadId);

  return {
    leadCampaignId,
    leadId,
    apolloPersonId: lead?.apolloPersonId ?? null,
    enrichedAt: lead?.enrichedAt ?? null,
    hasEmail: primary !== null,
    primaryEmail: primary?.email ?? null,
    primaryEmailStatus: primary?.status ?? null,
  };
}

async function setLeadCampaignStatus(
  leadCampaignId: string,
  status: "skipped" | "served",
  reason?: string,
  details?: string,
): Promise<void> {
  await db
    .update(leadsCampaigns)
    .set({
      status,
      statusReason: reason ?? null,
      statusDetails: details ?? null,
      ...(status === "served" ? { servedAt: new Date() } : {}),
      updatedAt: new Date(),
    })
    .where(eq(leadsCampaigns.id, leadCampaignId));
}

export async function pullNext(
  params: {
    orgId: string;
    campaignId: string;
    brandIds: string[];
    parentRunId?: string | null;
    runId?: string | null;
    userId?: string | null;
    workflowSlug?: string;
    featureSlug?: string;
  },
  signal?: AbortSignal,
): Promise<{
  found: boolean;
  lead?: {
    leadId: string;
    email: string;
    data: unknown;
    brandIds: string[];
    orgId: string | null;
    userId: string | null;
    apolloPersonId: string | null;
  };
}> {
  const brandIdCsv = params.brandIds.join(",");

  // Stale claimed recovery: any leads_campaigns rows stuck in 'claimed' for >1h
  // get reset to 'buffered'. Filet de sécurité if a previous pullNext crashed mid-flight.
  const staleCutoff = new Date(Date.now() - 60 * 60 * 1000);
  const staleRecovered = await pgSql`
    UPDATE leads_campaigns
    SET status = 'buffered', updated_at = NOW()
    WHERE org_id = ${params.orgId}
      AND campaign_id = ${params.campaignId}
      AND status = 'claimed'
      AND updated_at < ${staleCutoff.toISOString()}::timestamptz
    RETURNING id
  `;
  if (staleRecovered.length > 0) {
    console.log(
      `[lead-service] pullNext recovered ${staleRecovered.length} stale claimed leads for campaign=${params.campaignId}`,
    );
  }

  while (!signal?.aborted) {
    const claimed = await claimNextLeadCampaign(params.orgId, params.campaignId);

    if (!claimed) {
      const result = await topUpApolloLeadBuffer(
        {
          orgId: params.orgId,
          campaignId: params.campaignId,
          brandIds: params.brandIds,
          pushRunId: params.runId,
          userId: params.userId,
          workflowSlug: params.workflowSlug,
          featureSlug: params.featureSlug,
        },
        signal,
      );

      if (result.filled > 0) continue;

      console.log(`[lead-service] pullNext found=false campaign=${params.campaignId}`);
      return { found: false };
    }

    // Pre-enrich brand dedup (uses apolloPersonId only).
    if (claimed.apolloPersonId) {
      const preCheck = await isAlreadyServedForBrand({
        orgId: params.orgId,
        brandIds: params.brandIds,
        apolloPersonId: claimed.apolloPersonId,
      });
      if (preCheck.blocked) {
        await setLeadCampaignStatus(
          claimed.leadCampaignId,
          "skipped",
          "pre_enrich_brand_dedup",
          `Already served for overlapping brand (pre-enrich), apolloPersonId=${claimed.apolloPersonId}, campaignId=${params.campaignId}, brandIds=${brandIdCsv}`,
        );
        continue;
      }
    }

    let email = claimed.primaryEmail;
    let emailStatus = claimed.primaryEmailStatus;

    const cacheFresh = isCacheFresh(claimed.enrichedAt, claimed.hasEmail);
    const needEnrich = !email && !cacheFresh;

    if (needEnrich && claimed.apolloPersonId) {
      const enrichResult = await apolloEnrich(claimed.apolloPersonId, {
        runId: params.runId,
        orgId: params.orgId,
        userId: params.userId,
        brandId: brandIdCsv,
        campaignId: params.campaignId,
        workflowSlug: params.workflowSlug,
        featureSlug: params.featureSlug,
      });

      if (enrichResult?.person) {
        await upsertLeadFromPerson(enrichResult.person, { enriched: true });
        await recordEmploymentHistory({ leadId: claimed.leadId, person: enrichResult.person });
        if (enrichResult.person.email) {
          await upsertContactMethod({
            leadId: claimed.leadId,
            channel: "email",
            value: enrichResult.person.email,
            status: enrichResult.person.emailStatus ?? null,
            source: "apollo",
          });
          email = enrichResult.person.email;
          emailStatus = enrichResult.person.emailStatus ?? null;
        }
      } else {
        await db
          .update(leads)
          .set({ enrichedAt: new Date() })
          .where(eq(leads.id, claimed.leadId));
      }
    }

    if (!email) {
      const stillHasEmail = await leadHasEmail(claimed.leadId);
      if (!stillHasEmail) {
        await setLeadCampaignStatus(
          claimed.leadCampaignId,
          "skipped",
          "no_email",
          `No email after enrichment, leadId=${claimed.leadId}, apolloPersonId=${claimed.apolloPersonId ?? "none"}, campaignId=${params.campaignId}`,
        );
        continue;
      }
      const refreshed = await getPrimaryEmail(claimed.leadId);
      if (!refreshed) {
        await setLeadCampaignStatus(
          claimed.leadCampaignId,
          "skipped",
          "no_email",
          `No primary email row after enrichment, leadId=${claimed.leadId}, campaignId=${params.campaignId}`,
        );
        continue;
      }
      email = refreshed.email;
      emailStatus = refreshed.status;
    }

    if (emailStatus && !VALID_EMAIL_STATUSES.has(emailStatus)) {
      await setLeadCampaignStatus(
        claimed.leadCampaignId,
        "skipped",
        "invalid_email_status",
        `Email status "${emailStatus}" not valid (verified/extrapolated required), email=${email}, leadId=${claimed.leadId}, campaignId=${params.campaignId}`,
      );
      continue;
    }

    const brandCheck = await isAlreadyServedForBrand({
      orgId: params.orgId,
      brandIds: params.brandIds,
      leadId: claimed.leadId,
      email,
      apolloPersonId: claimed.apolloPersonId,
    });
    if (brandCheck.blocked) {
      await setLeadCampaignStatus(
        claimed.leadCampaignId,
        "skipped",
        "brand_dedup",
        `Already served for overlapping brand (post-enrich), email=${email}, leadId=${claimed.leadId}, campaignId=${params.campaignId}, brandIds=${brandIdCsv}, reason=${brandCheck.reason}`,
      );
      continue;
    }

    const inRaceWindow = await checkRaceWindow({
      orgId: params.orgId,
      brandIds: params.brandIds,
      email,
      excludeLeadCampaignId: claimed.leadCampaignId,
    });
    if (inRaceWindow) {
      await setLeadCampaignStatus(
        claimed.leadCampaignId,
        "skipped",
        "race_window",
        `Concurrent claim/serve detected, email=${email}, leadId=${claimed.leadId}, campaignId=${params.campaignId}`,
      );
      continue;
    }

    const statusMap = await checkContacted(params.brandIds, params.campaignId, [{ email }], {
      orgId: params.orgId,
      userId: params.userId ?? undefined,
      runId: params.runId ?? undefined,
      campaignId: params.campaignId,
      brandId: brandIdCsv,
      workflowSlug: params.workflowSlug,
      featureSlug: params.featureSlug,
    });
    const gw = statusMap.get(email);
    if (gw?.contacted) {
      await setLeadCampaignStatus(
        claimed.leadCampaignId,
        "skipped",
        "contacted",
        `Already contacted via email-gateway, email=${email}, leadId=${claimed.leadId}, campaignId=${params.campaignId}`,
      );
      continue;
    }
    if (gw?.bounced) {
      await setLeadCampaignStatus(
        claimed.leadCampaignId,
        "skipped",
        "bounced",
        `Email previously bounced, email=${email}, leadId=${claimed.leadId}, campaignId=${params.campaignId}`,
      );
      continue;
    }
    if (gw?.unsubscribed) {
      await setLeadCampaignStatus(
        claimed.leadCampaignId,
        "skipped",
        "unsubscribed",
        `Email unsubscribed, email=${email}, leadId=${claimed.leadId}, campaignId=${params.campaignId}`,
      );
      continue;
    }

    await db
      .update(leadsCampaigns)
      .set({
        status: "served",
        statusReason: "served",
        statusDetails: `Lead served, email=${email}, leadId=${claimed.leadId}, campaignId=${params.campaignId}`,
        servedAt: new Date(),
        parentRunId: params.parentRunId ?? null,
        runId: params.runId ?? null,
        updatedAt: new Date(),
      })
      .where(eq(leadsCampaigns.id, claimed.leadCampaignId));

    const leadRow = await db.query.leads.findFirst({ where: eq(leads.id, claimed.leadId) });
    const finalData: Record<string, unknown> = {
      ...(leadRow?.metadata && typeof leadRow.metadata === "object" ? (leadRow.metadata as Record<string, unknown>) : {}),
      email,
    };

    console.log(
      `[lead-service] pullNext found=true campaign=${params.campaignId} email=${email} leadId=${claimed.leadId}`,
    );
    return {
      found: true,
      lead: {
        leadId: claimed.leadId,
        email,
        data: finalData,
        brandIds: params.brandIds,
        orgId: params.orgId,
        userId: params.userId ?? null,
        apolloPersonId: claimed.apolloPersonId,
      },
    };
  }

  // Aborted (timeout from caller's AbortSignal)
  return { found: false };
}

export { leadContactMethods, leadsCampaigns };
