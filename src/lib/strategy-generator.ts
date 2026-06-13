import { eq, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { campaignsApolloStrategies } from "../db/schema.js";
import { MAX_STRATEGY_GENERATION_ROUNDS } from "../config.js";
import { chatComplete } from "./chat-client.js";
import {
  peopleDryRun,
  fetchFiltersPrompt,
  type PeopleFilters,
  type PeopleProvider,
} from "./people-client.js";

export interface StrategyContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
  campaignId: string;
  brandId: string;
  /** Lead provider this campaign sources through (apollo | apify). */
  provider: PeopleProvider;
  workflowSlug?: string;
  featureSlug?: string;
  /** Pre-formatted brand + campaign description used as the LLM seed. */
  brandCampaignDescription: string;
}

export type StrategyOutcome =
  | { strategy: PeopleFilters }
  | { exhausted: true; reason: string };

// Static portion of the system prompt. The provider-specific filter-shape doc is
// appended per-call from the human-service people gateway
// GET /orgs/people/filters-prompt?provider= (single source of truth).
const SYSTEM_PROMPT_STATIC = `You are a B2B lead search filter generator for an outreach campaign.

CONTEXT YOU RECEIVE:
- Brand: name, industry, target geography, ideal lead type, target job titles, offerings
- Campaign: target audience, target outcome, value for target
- Previously tried strategies (filter sets that have been exhausted)

YOUR JOB:
Generate ONE new search filter set that:
1. Stays STRICTLY within the campaign target audience and brand offerings.
2. Is DISTINCT from all previously tried strategies (different titles / industries / locations).
3. Will likely return >0 results.

ABSOLUTE RULES:
- NEVER expand outside the campaign's stated target audience or geography.
- NEVER expand outside the brand's stated industry/offerings unless the brand's offerings list explicitly includes adjacent verticals.
  Example: brand sells dental supplies → target dentists, dental hygienists, orthodontists. NOT general practitioners, NOT pharmacists, NOT veterinarians.
  Example: brand sells SaaS to fintech CFOs in US → never propose insurance CFOs, never propose UK/EU.
- If you cannot find ANY new filter set that fits within scope AND is distinct from previous attempts, return {"action": "exhausted", "reason": "<one sentence>"}.

WORKFLOW:
You operate in a multi-turn loop. On each turn, respond with EXACTLY ONE JSON object.
The user will tell you the result of any "test" you propose, then ask for the next action.
If a test returns validation errors, you MUST keep iterating with new test actions; do NOT confirm a filter set that has unresolved validation errors.

OUTPUT FORMAT (JSON):

To propose filters for testing:
{"action": "test", "filters": {<search filter object>}, "reasoning": "<one sentence>"}

To confirm the last tested filter set is good (only allowed when the last test returned zero validation errors):
{"action": "confirm", "reasoning": "<one sentence>"}

To declare no viable alternative exists in scope:
{"action": "exhausted", "reason": "<why no viable alternative exists>"}`;

function buildSystemPrompt(filtersPrompt: string): string {
  return `${SYSTEM_PROMPT_STATIC}\n\n${filtersPrompt}`;
}

// Filter-shape doc differs per provider, so the cache is keyed by provider.
const cachedFiltersPrompt = new Map<PeopleProvider, { schemaVersion: string; prompt: string }>();

async function getFiltersPrompt(
  provider: PeopleProvider,
  orgId: string,
  userId: string | null,
): Promise<string> {
  const fresh = await fetchFiltersPrompt({ provider, orgId, userId });
  const cached = cachedFiltersPrompt.get(provider);
  if (!cached || cached.schemaVersion !== fresh.schemaVersion) {
    if (cached && cached.schemaVersion !== fresh.schemaVersion) {
      console.log(
        `[lead-service] ${provider} filters-prompt schemaVersion changed: ${cached.schemaVersion} -> ${fresh.schemaVersion}`,
      );
    }
    cachedFiltersPrompt.set(provider, { schemaVersion: fresh.schemaVersion, prompt: fresh.prompt });
  }
  return cachedFiltersPrompt.get(provider)!.prompt;
}

// Test-only: lets unit tests reset the module-level cache between cases.
export function __resetFiltersPromptCache(): void {
  cachedFiltersPrompt.clear();
}

export const __SYSTEM_PROMPT_STATIC__ = SYSTEM_PROMPT_STATIC;

interface LlmAction {
  action?: unknown;
  filters?: unknown;
  reasoning?: unknown;
  reason?: unknown;
}

function isValidFilters(filters: unknown): filters is PeopleFilters {
  return !!filters && typeof filters === "object" && !Array.isArray(filters);
}

function buildSeedMessage(brandCampaignDescription: string, previousStrategies: PeopleFilters[]): string {
  const previousJson =
    previousStrategies.length === 0
      ? "(none yet — this is the first strategy for this campaign)"
      : JSON.stringify(previousStrategies, null, 2);
  return [
    "BRAND + CAMPAIGN CONTEXT:",
    brandCampaignDescription,
    "",
    "PREVIOUSLY TRIED STRATEGIES (already exhausted, do NOT repeat):",
    previousJson,
    "",
    "Generate the next strategy. Respond with ONE JSON action: test, confirm, or exhausted.",
  ].join("\n");
}

export async function generateNextStrategy(
  ctx: StrategyContext,
  previousStrategies: PeopleFilters[],
  searchError?: string,
): Promise<StrategyOutcome> {
  const transcript: string[] = [buildSeedMessage(ctx.brandCampaignDescription, previousStrategies)];
  if (searchError) {
    transcript.push(
      `PRIOR SEARCH ERROR (the last persisted strategy was rejected by the provider at fetch time, treat as a validation failure to avoid):\n${searchError}`,
    );
  }
  let lastTestedFilters: PeopleFilters | null = null;
  let lastTestedHadErrors = false;

  const tracking = {
    orgId: ctx.orgId,
    userId: ctx.userId ?? null,
    runId: ctx.runId ?? null,
    campaignId: ctx.campaignId,
    brandId: ctx.brandId,
    workflowSlug: ctx.workflowSlug ?? null,
    featureSlug: ctx.featureSlug ?? null,
  };

  const filtersPrompt = await getFiltersPrompt(ctx.provider, ctx.orgId, ctx.userId ?? null);
  const systemPrompt = buildSystemPrompt(filtersPrompt);

  for (let round = 0; round < MAX_STRATEGY_GENERATION_ROUNDS; round++) {
    const completion = await chatComplete(
      {
        message: transcript.join("\n\n---\n\n"),
        systemPrompt,
        provider: "google",
        model: "pro",
        responseFormat: "json",
      },
      tracking,
    );

    const action = (completion.json ?? {}) as LlmAction;
    const actionType = typeof action.action === "string" ? action.action : "";

    if (actionType === "exhausted") {
      const reason = typeof action.reason === "string" ? action.reason : "LLM declared exhausted with no reason";
      return { exhausted: true, reason };
    }

    if (actionType === "test") {
      if (!isValidFilters(action.filters)) {
        transcript.push(
          `Round ${round + 1}: your "test" action was missing a valid "filters" object. Provide filters as a JSON object of search params.`,
        );
        continue;
      }
      const filters = action.filters as PeopleFilters;
      try {
        const dry = await peopleDryRun({
          provider: ctx.provider,
          filters,
          orgId: ctx.orgId,
          userId: ctx.userId ?? null,
          runId: ctx.runId ?? null,
          brandId: ctx.brandId,
          campaignId: ctx.campaignId,
          workflowSlug: ctx.workflowSlug,
          featureSlug: ctx.featureSlug,
        });
        lastTestedFilters = filters;
        lastTestedHadErrors = false;
        transcript.push(
          [
            `Round ${round + 1}: tested filters=${JSON.stringify(filters)}`,
            `Result: totalEntries=${dry.totalEntries}.`,
            `Either confirm this set, propose another test, or declare exhausted.`,
          ].join("\n"),
        );
      } catch (err) {
        lastTestedFilters = null;
        lastTestedHadErrors = true;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `[lead-service] strategy dryRun threw, feeding error back to LLM round=${round + 1}: ${message}`,
        );
        transcript.push(
          [
            `Round ${round + 1}: tested filters=${JSON.stringify(filters)}`,
            `Result: the provider rejected the request with an error. Treat this as a validation failure to avoid:`,
            message,
            `Propose another "test" with corrected filters, or declare exhausted.`,
          ].join("\n"),
        );
      }
      continue;
    }

    if (actionType === "confirm") {
      if (!lastTestedFilters) {
        transcript.push(
          `Round ${round + 1}: you tried to confirm without testing any filters yet. You must test at least one filter set first.`,
        );
        continue;
      }
      if (lastTestedHadErrors) {
        transcript.push(
          `Round ${round + 1}: confirm rejected — the last tested filter set was rejected by the provider. Propose a new "test" with corrected filters.`,
        );
        continue;
      }
      return { strategy: lastTestedFilters };
    }

    transcript.push(
      `Round ${round + 1}: unrecognized action ${JSON.stringify(actionType)}. Use one of: test, confirm, exhausted.`,
    );
  }

  return { exhausted: true, reason: "Max rounds reached" };
}

interface StrategyRow {
  id: string;
  strategies: PeopleFilters[];
  currentIndex: number;
  apifyOffset: number;
  exhausted: boolean;
  exhaustionReason: string | null;
}

async function loadRow(orgId: string, campaignId: string): Promise<StrategyRow | null> {
  const row = await db.query.campaignsApolloStrategies.findFirst({
    where: and(
      eq(campaignsApolloStrategies.orgId, orgId),
      eq(campaignsApolloStrategies.campaignId, campaignId),
    ),
  });
  if (!row) return null;
  return {
    id: row.id,
    strategies: (row.strategies as PeopleFilters[] | null) ?? [],
    currentIndex: row.currentIndex,
    apifyOffset: row.apifyOffset ?? 0,
    exhausted: row.exhausted,
    exhaustionReason: row.exhaustionReason ?? null,
  };
}

export type CurrentStrategy =
  | { strategy: PeopleFilters; apifyOffset: number }
  | { exhausted: true; reason: string };

async function persistOutcome(params: {
  orgId: string;
  campaignId: string;
  existing: StrategyRow | null;
  outcome: StrategyOutcome;
  appendStrategy: boolean;
}): Promise<CurrentStrategy> {
  const { orgId, campaignId, existing, outcome, appendStrategy } = params;
  if ("exhausted" in outcome) {
    if (existing) {
      await db
        .update(campaignsApolloStrategies)
        .set({ exhausted: true, exhaustionReason: outcome.reason, updatedAt: new Date() })
        .where(eq(campaignsApolloStrategies.id, existing.id));
    } else {
      await db.insert(campaignsApolloStrategies).values({
        orgId,
        campaignId,
        strategies: [],
        currentIndex: 0,
        exhausted: true,
        exhaustionReason: outcome.reason,
      });
    }
    return { exhausted: true, reason: outcome.reason };
  }

  // success: persist new strategy. A new strategy resets apify pagination to 0.
  const strategy = outcome.strategy;
  if (existing) {
    const newStrategies = appendStrategy ? [...existing.strategies, strategy] : existing.strategies;
    const newIndex = appendStrategy ? newStrategies.length - 1 : existing.currentIndex;
    await db
      .update(campaignsApolloStrategies)
      .set({
        strategies: newStrategies,
        currentIndex: newIndex,
        apifyOffset: 0,
        exhausted: false,
        exhaustionReason: null,
        updatedAt: new Date(),
      })
      .where(eq(campaignsApolloStrategies.id, existing.id));
  } else {
    await db.insert(campaignsApolloStrategies).values({
      orgId,
      campaignId,
      strategies: [strategy],
      currentIndex: 0,
      apifyOffset: 0,
      exhausted: false,
    });
  }
  return { strategy, apifyOffset: 0 };
}

/**
 * Persist the apify pagination offset for the current strategy of a campaign.
 * apollo uses a server-managed cursor (no local state); apify is client-managed,
 * so the offset must survive across buffer/next calls.
 */
export async function persistApifyOffset(
  orgId: string,
  campaignId: string,
  offset: number,
): Promise<void> {
  await db
    .update(campaignsApolloStrategies)
    .set({ apifyOffset: offset, updatedAt: new Date() })
    .where(
      and(
        eq(campaignsApolloStrategies.orgId, orgId),
        eq(campaignsApolloStrategies.campaignId, campaignId),
      ),
    );
}

/**
 * Returns the strategy lead-service should use right now for this campaign.
 * Generates one if the row is missing. Returns exhausted permanently if previously marked exhausted.
 */
export async function getCurrentStrategy(ctx: StrategyContext): Promise<CurrentStrategy> {
  if (!ctx.orgId) {
    throw new Error("[lead-service] getCurrentStrategy: orgId is required");
  }
  if (!ctx.campaignId) {
    throw new Error("[lead-service] getCurrentStrategy: campaignId is required");
  }
  const existing = await loadRow(ctx.orgId, ctx.campaignId);

  if (existing?.exhausted) {
    return { exhausted: true, reason: existing.exhaustionReason ?? "Strategies marked exhausted" };
  }

  if (existing && existing.currentIndex < existing.strategies.length) {
    return { strategy: existing.strategies[existing.currentIndex], apifyOffset: existing.apifyOffset };
  }

  // Either no row, or currentIndex past end. Generate a fresh strategy.
  const outcome = await generateNextStrategy(ctx, existing?.strategies ?? []);
  return persistOutcome({
    orgId: ctx.orgId,
    campaignId: ctx.campaignId,
    existing,
    outcome,
    appendStrategy: true,
  });
}

/**
 * Mark the current strategy as exhausted (provider returned no more leads, or
 * rejected the persisted filter set) and try to generate the next strategy. Used
 * by buffer fill when a page returns 0 candidates or the provider throws.
 */
export async function advanceStrategyOrGenerate(
  ctx: StrategyContext,
  searchError?: string,
): Promise<CurrentStrategy> {
  const existing = await loadRow(ctx.orgId, ctx.campaignId);

  if (existing?.exhausted) {
    return { exhausted: true, reason: existing.exhaustionReason ?? "Strategies marked exhausted" };
  }

  // Bump index past current strategy; subsequent generateNextStrategy uses all known strategies as the "tried" set.
  const triedStrategies = existing?.strategies ?? [];
  const outcome = await generateNextStrategy(ctx, triedStrategies, searchError);
  return persistOutcome({
    orgId: ctx.orgId,
    campaignId: ctx.campaignId,
    existing,
    outcome,
    appendStrategy: true,
  });
}
