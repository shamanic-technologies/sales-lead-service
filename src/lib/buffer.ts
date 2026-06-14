import { eq, and, count } from "drizzle-orm";
import { db, sql as pgSql } from "../db/index.js";
import { leadsCampaigns, leadContactMethods, leads, leadsOrganizations, organizations } from "../db/schema.js";
import { TARGET_BUFFER_SIZE } from "../config.js";
import {
  peopleSearch,
  resolveEmail,
  isPeopleCreditInsufficientError,
  type Person,
  type PeopleFilters,
  type PeopleProvider,
} from "./people-client.js";
import { CREDIT_INSUFFICIENT_REASON, type CreditInsufficientReason } from "./credit-errors.js";
import {
  upsertLeadFromPerson,
  recordEmploymentHistory,
  upsertContactMethod,
  leadHasEmail,
  getPrimaryEmail,
} from "./leads-registry.js";
import { buildFullLead } from "./lead-shape.js";
import {
  checkContacted,
  isAlreadyServedForBrand,
  checkRaceWindow,
} from "./dedup.js";
import {
  getCurrentStrategy,
  advanceStrategyOrGenerate,
  persistApifyOffset,
  type StrategyContext,
} from "./strategy-generator.js";
import { fetchCampaign } from "./campaign-client.js";
import { extractBrandFields } from "./brand-client.js";

// Servable email-verdict statuses, provider-agnostic (the gateway normalizes
// both providers into one neutral Person; do NOT branch on provider here):
//   - apollo: "verified" (billed enrich) + "extrapolated" (pattern-inferred)
//   - apify:  "deliverable" (verified-email waterfall positive verdict)
// apify's negative verdicts (undeliverable/risky/unknown) are intentionally
// absent — a lead whose email status isn't here is skipped as invalid.
export const VALID_EMAIL_STATUSES = new Set(["verified", "extrapolated", "deliverable"]);

/**
 * TTL for re-enriching a lead. A lead with a valid email short-circuits
 * before this check, so the TTL only governs how soon we retry leads whose
 * latest enrichment did NOT yield a usable email (or had an invalid status).
 */
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function isCacheFresh(enrichedAt: Date | null): boolean {
  if (!enrichedAt) return false;
  return Date.now() - enrichedAt.getTime() < CACHE_TTL_MS;
}

export function hasValidEmail(email: string | null, status: string | null): boolean {
  return !!email && !!status && VALID_EMAIL_STATUSES.has(status);
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
  provider: PeopleProvider;
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
    provider: params.provider,
    workflowSlug: params.workflowSlug,
    featureSlug: params.featureSlug,
    brandCampaignDescription: lines.join("\n"),
  };
}

interface IngestParams {
  orgId: string;
  campaignId: string;
  brandIds: string[];
  provider: PeopleProvider;
  pushRunId?: string | null;
  userId?: string | null;
  workflowSlug?: string;
  featureSlug?: string;
}

/**
 * Insert one neutral gateway Person into the schema:
 *   - upsert leads (apollo: by providerPersonId; apify: by email)
 *   - upsert organization + current employment
 *   - upsert email contact method (when present)
 *   - insert leads_campaigns row (status='buffered')
 * Returns true when a NEW leads_campaigns row was inserted (i.e. we added to buffer).
 */
async function ingestPerson(person: Person, params: IngestParams, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  // apollo identifies by provider person id; apify (no person id) by verified email.
  if (!person.providerPersonId && !person.email) return false;

  const leadId = await upsertLeadFromPerson(person, { enriched: false });
  if (signal?.aborted) return false;

  await recordEmploymentHistory({ leadId, person });
  if (signal?.aborted) return false;

  if (person.email) {
    const res = await upsertContactMethod({
      leadId,
      channel: "email",
      value: person.email,
      status: person.emailStatus ?? null,
      source: params.provider,
    });
    if (!res.inserted) {
      console.warn(
        `[lead-service] ingest skip — email already attached to another lead, provider=${params.provider}, personId=${person.providerPersonId ?? "none"}, email=${person.email}`,
      );
      return false;
    }
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

export async function topUpApolloLeadBuffer(
  params: IngestParams,
  signal?: AbortSignal,
): Promise<{ filled: number; reason?: CreditInsufficientReason }> {
  const brandIdCsv = params.brandIds.join(",");
  const ctx = await buildStrategyContext({
    orgId: params.orgId,
    campaignId: params.campaignId,
    brandIdCsv,
    provider: params.provider,
    pushRunId: params.pushRunId,
    userId: params.userId,
    workflowSlug: params.workflowSlug,
    featureSlug: params.featureSlug,
  });

  let totalInserted = 0;
  let freshStrategy = true;
  let activeStrategy: PeopleFilters | null = null;
  let apifyOffset = 0;

  while (!signal?.aborted) {
    const buffered = await bufferedCount(params.orgId, params.campaignId);
    if (buffered + totalInserted >= TARGET_BUFFER_SIZE) {
      return { filled: totalInserted };
    }

    if (!activeStrategy) {
      let current: Awaited<ReturnType<typeof getCurrentStrategy>>;
      try {
        current = await getCurrentStrategy(ctx);
      } catch (err) {
        if (isPeopleCreditInsufficientError(err)) {
          return { filled: totalInserted, reason: CREDIT_INSUFFICIENT_REASON };
        }
        throw err;
      }
      if ("exhausted" in current) {
        console.log(
          `[lead-service] topUp exhausted campaign=${params.campaignId} reason=${current.reason}`,
        );
        return { filled: totalInserted };
      }
      activeStrategy = current.strategy;
      apifyOffset = current.apifyOffset;
      freshStrategy = true;
    }

    let page: Awaited<ReturnType<typeof peopleSearch>>;
    try {
      page = await peopleSearch({
        provider: params.provider,
        // apollo: filters on the first page only, then advance the server cursor.
        // apify: stateless — send filters + offset on every page.
        filters:
          params.provider === "apify" || freshStrategy ? activeStrategy : undefined,
        nextPage: params.provider === "apollo" && !freshStrategy ? true : undefined,
        offset: params.provider === "apify" ? apifyOffset : undefined,
        campaignId: params.campaignId,
        brandId: brandIdCsv,
        runId: params.pushRunId ?? null,
        orgId: params.orgId,
        userId: params.userId ?? null,
        workflowSlug: params.workflowSlug,
        featureSlug: params.featureSlug,
      });
    } catch (err) {
      // Provider rejected the persisted strategy (e.g. validation error after schema tightening,
      // or LLM previously confirmed an invalid filter). Don't propagate — invalidate the strategy
      // and feed the error back to the LLM loop so it can converge on a valid filter set.
      // Stay quiet on per-attempt failures; only surface a log when all strategies are exhausted.
      const lastSearchError = err instanceof Error ? err.message : String(err);
      if (isPeopleCreditInsufficientError(err)) {
        return { filled: totalInserted, reason: CREDIT_INSUFFICIENT_REASON };
      }
      let next: Awaited<ReturnType<typeof advanceStrategyOrGenerate>>;
      try {
        next = await advanceStrategyOrGenerate(ctx, lastSearchError);
      } catch (strategyErr) {
        if (isPeopleCreditInsufficientError(strategyErr)) {
          return { filled: totalInserted, reason: CREDIT_INSUFFICIENT_REASON };
        }
        throw strategyErr;
      }
      if ("exhausted" in next) {
        console.warn(
          `[lead-service] topUp strategies exhausted after provider rejection campaign=${params.campaignId} reason=${next.reason} lastError=${lastSearchError}`,
        );
        return { filled: totalInserted };
      }
      activeStrategy = next.strategy;
      apifyOffset = next.apifyOffset;
      freshStrategy = true;
      continue;
    }
    freshStrategy = false;

    let pageInserted = 0;
    for (const person of page.people) {
      if (signal?.aborted) break;
      const ok = await ingestPerson(person, params, signal);
      if (ok) pageInserted++;
    }
    totalInserted += pageInserted;

    // apify pagination is client-managed: advance + persist the offset so the next
    // buffer/next call resumes where this one left off (apollo's cursor is server-side).
    if (params.provider === "apify") {
      apifyOffset = page.nextOffset ?? apifyOffset;
      await persistApifyOffset(params.orgId, params.campaignId, apifyOffset);
    }

    if (page.done || page.people.length === 0) {
      let next: Awaited<ReturnType<typeof advanceStrategyOrGenerate>>;
      try {
        next = await advanceStrategyOrGenerate(ctx);
      } catch (err) {
        if (isPeopleCreditInsufficientError(err)) {
          return { filled: totalInserted, reason: CREDIT_INSUFFICIENT_REASON };
        }
        throw err;
      }
      if ("exhausted" in next) {
        console.log(
          `[lead-service] topUp strategies exhausted campaign=${params.campaignId} reason=${next.reason}`,
        );
        return { filled: totalInserted };
      }
      activeStrategy = next.strategy;
      apifyOffset = next.apifyOffset;
      freshStrategy = true;
    }
  }

  return { filled: totalInserted };
}

interface ClaimedRow {
  leadCampaignId: string;
  leadId: string;
  apolloPersonId: string | null;
  firstName: string | null;
  lastName: string | null;
  domain: string | null;
  enrichedAt: Date | null;
  hasEmail: boolean;
  primaryEmail: string | null;
  primaryEmailStatus: string | null;
}

/** Domain of the lead's current employer, used to resolve a verified email via the gateway. */
async function getCurrentOrgDomain(leadId: string): Promise<string | null> {
  const row = await db
    .select({ domain: organizations.primaryDomain })
    .from(leadsOrganizations)
    .innerJoin(organizations, eq(leadsOrganizations.organizationId, organizations.id))
    .where(and(eq(leadsOrganizations.leadId, leadId), eq(leadsOrganizations.current, true)))
    .limit(1);
  return row[0]?.domain ?? null;
}

async function claimNextLeadCampaign(orgId: string, campaignId: string): Promise<ClaimedRow | null> {
  // campaign-service serializes workflow runs per campaign, so concurrent pullNext calls for the
  // same (orgId, campaignId) cannot happen. A plain UPDATE on the oldest buffered row is enough.
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
    )
    RETURNING id, lead_id
  `;
  if (claimed.length === 0) return null;
  const { id: leadCampaignId, lead_id: leadId } = claimed[0];

  const lead = await db.query.leads.findFirst({
    where: eq(leads.id, leadId),
  });
  const primary = await getPrimaryEmail(leadId);
  const domain = await getCurrentOrgDomain(leadId);

  return {
    leadCampaignId,
    leadId,
    apolloPersonId: lead?.apolloPersonId ?? null,
    firstName: lead?.firstName ?? null,
    lastName: lead?.lastName ?? null,
    domain,
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
    provider: PeopleProvider;
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
  reason?: CreditInsufficientReason;
}> {
  const brandIdCsv = params.brandIds.join(",");

  while (!signal?.aborted) {
    const claimed = await claimNextLeadCampaign(params.orgId, params.campaignId);

    if (!claimed) {
      const result = await topUpApolloLeadBuffer(
        {
          orgId: params.orgId,
          campaignId: params.campaignId,
          brandIds: params.brandIds,
          provider: params.provider,
          pushRunId: params.runId,
          userId: params.userId,
          workflowSlug: params.workflowSlug,
          featureSlug: params.featureSlug,
        },
        signal,
      );

      if (result.filled > 0) continue;
      if (result.reason === CREDIT_INSUFFICIENT_REASON) {
        console.log(`[lead-service] pullNext found=false campaign=${params.campaignId} reason=credit_insufficient`);
        return { found: false, reason: CREDIT_INSUFFICIENT_REASON };
      }

      console.log(`[lead-service] pullNext found=false campaign=${params.campaignId}`);
      return { found: false };
    }

    // Release the claim back to 'buffered' if processing throws below — caller can retry.
    let claimSettled = false;
    const settleSkip = async (reason: string, details: string) => {
      await setLeadCampaignStatus(claimed.leadCampaignId, "skipped", reason, details);
      claimSettled = true;
    };

    try {
      // Pre-enrich brand dedup (uses apolloPersonId only).
      if (claimed.apolloPersonId) {
        const preCheck = await isAlreadyServedForBrand({
          orgId: params.orgId,
          brandIds: params.brandIds,
          apolloPersonId: claimed.apolloPersonId,
        });
        if (preCheck.blocked) {
          await settleSkip(
            "pre_enrich_brand_dedup",
            `Already served for overlapping brand (pre-enrich), apolloPersonId=${claimed.apolloPersonId}, campaignId=${params.campaignId}, brandIds=${brandIdCsv}`,
          );
          continue;
        }
      }

      let email = claimed.primaryEmail;
      let emailStatus = claimed.primaryEmailStatus;

      const validEmail = hasValidEmail(email, emailStatus);
      const cacheFresh = isCacheFresh(claimed.enrichedAt);
      const needEnrich = !validEmail && !cacheFresh;

      // Reveal a verified email via the gateway resolve-email. The gateway is
      // generic: it reveals by the provider's person id (apollo /enrich, the
      // billed path) when we have one, else by identity (name + org domain).
      // We hand it every identity field we stored and let it pick the path —
      // the apollo person id is only ever populated on apollo-sourced leads, so
      // (provider, apolloPersonId) is always consistent. A lead with neither a
      // person id nor full identity is genuinely unresolvable.
      const hasIdentity = !!(claimed.firstName && claimed.lastName && claimed.domain);
      const canResolve = !!claimed.apolloPersonId || hasIdentity;
      if (needEnrich && canResolve) {
        let enrichResult: Awaited<ReturnType<typeof resolveEmail>>;
        try {
          enrichResult = await resolveEmail({
            provider: params.provider,
            providerPersonId: claimed.apolloPersonId ?? undefined,
            firstName: hasIdentity ? (claimed.firstName as string) : undefined,
            lastName: hasIdentity ? (claimed.lastName as string) : undefined,
            domain: hasIdentity ? (claimed.domain as string) : undefined,
            runId: params.runId,
            orgId: params.orgId,
            userId: params.userId,
            brandId: brandIdCsv,
            campaignId: params.campaignId,
            workflowSlug: params.workflowSlug,
            featureSlug: params.featureSlug,
          });
        } catch (err) {
          if (isPeopleCreditInsufficientError(err)) {
            await db
              .update(leadsCampaigns)
              .set({ status: "buffered", updatedAt: new Date() })
              .where(eq(leadsCampaigns.id, claimed.leadCampaignId));
            claimSettled = true;
            console.log(`[lead-service] pullNext found=false campaign=${params.campaignId} reason=credit_insufficient`);
            return { found: false, reason: CREDIT_INSUFFICIENT_REASON };
          }
          throw err;
        }

        if (enrichResult?.person) {
          await upsertLeadFromPerson(enrichResult.person, { enriched: true });
          await recordEmploymentHistory({ leadId: claimed.leadId, person: enrichResult.person });
          if (enrichResult.person.email) {
            const primary = enrichResult.person.email;
            const primaryStatus = enrichResult.person.emailStatus ?? null;
            const res = await upsertContactMethod({
              leadId: claimed.leadId,
              channel: "email",
              value: primary,
              status: primaryStatus,
              source: params.provider,
            });
            if (res.inserted) {
              email = primary;
              emailStatus = primaryStatus;
            } else {
              await settleSkip(
                "email_collision_other_lead",
                `Resolved email already attached to another lead, email=${primary}, leadId=${claimed.leadId}, apolloPersonId=${claimed.apolloPersonId ?? "none"}, campaignId=${params.campaignId}`,
              );
              continue;
            }
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
          await settleSkip(
            "no_email",
            `No email after enrichment, leadId=${claimed.leadId}, apolloPersonId=${claimed.apolloPersonId ?? "none"}, campaignId=${params.campaignId}`,
          );
          continue;
        }
        const refreshed = await getPrimaryEmail(claimed.leadId);
        if (!refreshed) {
          await settleSkip(
            "no_email",
            `No primary email row after enrichment, leadId=${claimed.leadId}, campaignId=${params.campaignId}`,
          );
          continue;
        }
        email = refreshed.email;
        emailStatus = refreshed.status;
      }

      if (emailStatus && !VALID_EMAIL_STATUSES.has(emailStatus)) {
        await settleSkip(
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
        await settleSkip(
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
        await settleSkip(
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
        await settleSkip(
          "contacted",
          `Already contacted via email-gateway, email=${email}, leadId=${claimed.leadId}, campaignId=${params.campaignId}`,
        );
        continue;
      }
      if (gw?.bounced) {
        await settleSkip(
          "bounced",
          `Email previously bounced, email=${email}, leadId=${claimed.leadId}, campaignId=${params.campaignId}`,
        );
        continue;
      }
      if (gw?.unsubscribed) {
        await settleSkip(
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
      claimSettled = true;

      const fullLead = await buildFullLead(claimed.leadId);

      console.log(
        `[lead-service] pullNext found=true campaign=${params.campaignId} email=${email} leadId=${claimed.leadId}`,
      );
      return {
        found: true,
        lead: {
          leadId: claimed.leadId,
          email,
          data: fullLead,
          brandIds: params.brandIds,
          orgId: params.orgId,
          userId: params.userId ?? null,
          apolloPersonId: claimed.apolloPersonId,
        },
      };
    } finally {
      if (!claimSettled) {
        // Processing threw before we could mark the row terminal — release back to 'buffered'
        // so the next pullNext can retry. Without this the row would sit 'claimed' forever.
        try {
          await db
            .update(leadsCampaigns)
            .set({ status: "buffered", updatedAt: new Date() })
            .where(eq(leadsCampaigns.id, claimed.leadCampaignId));
          console.warn(
            `[lead-service] pullNext released claimed lead ${claimed.leadCampaignId} after exception`,
          );
        } catch (releaseErr) {
          console.error(
            `[lead-service] pullNext failed to release claim ${claimed.leadCampaignId}:`,
            releaseErr,
          );
        }
      }
    }
  }

  // Aborted (timeout from caller's AbortSignal)
  return { found: false };
}

export { leadContactMethods, leadsCampaigns };
