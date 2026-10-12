/**
 * The people who engage with our social posts become leads of the post's brand, with the engagement
 * on their timeline (owner 2026-10-12: the Social post pipe `social-post|start_to_industry_update_video`
 * is a campaign like any other; the people who like, comment, repost or quote the post are its step
 * `industry_update_video`, and every later step, website visit, signup, DM, paid client, must attach
 * to the same person so the lived-path read places them on the path they lived).
 *
 * social-service owns the fact (`GET /internal/social-engagements`, social-service#35: one fact per
 * post x person x action, keyed `sourceRef`, carrying the step key as `label`, the post's `campaignId`,
 * `orgId`, `brandId`). This module PULLS that feed and, per fact:
 *   1. resolves the person to ONE lead by their social identity (social-identity.ts), minting it when
 *      nobody holds them yet: no email needed, an email found later lands on the same lead;
 *   2. writes the fact on `lead_timeline_facts` as `social:<sourceRef>`, source `social`, attributable
 *      (a reaction to a post we published), at the brand, on the campaign's offer. Idempotent per
 *      `sourceRef`: re-reading the feed rewrites nothing.
 * A fact that states no org or brand is not anybody's lead yet (a post synced by hand without its
 * campaign): skipped and counted, written the sweep after social-service adopts its campaign. A label
 * the timeline vocabulary does not hold is counted as unplaced, never written under another name.
 *
 * Triggers: a background sweep every 10 min over the facts seen in the last 14 days (social-service
 * re-syncs a post's engagers every 6 h for 7 days), and `POST /internal/social-engagements/sync` for an
 * immediate pass (a workflow right after its engagers sync, a staff replay).
 */
import { z } from "zod";
import { SOCIAL_SERVICE_API_KEY, SOCIAL_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { fetchOrgCampaignOffers } from "./campaign-leg-client.js";
import { resolveSocialLead, socialIdentityOf, type SocialPerson } from "./social-identity.js";
import { upsertTimelineFacts, type TimelineFactRow } from "./timeline-facts.js";
import { TIMELINE_ITEM_LABELS, type TimelineItemLabel } from "./timeline-labels.js";

export const SOCIAL_ENGAGEMENTS_INTERVAL_MS = 10 * 60_000;
const FIRST_SWEEP_DELAY_MS = 120_000;
export const SOCIAL_ENGAGEMENTS_WINDOW_MS = 14 * 24 * 60 * 60_000;
/** social-service's own ceiling on one read. */
export const SOCIAL_ENGAGEMENTS_PAGE_LIMIT = 5000;

const nullableString = z.string().nullable();

/** One engagement fact, as social-service serves it (the fields this service reads). */
export const SocialEngagementFactSchema = z.object({
  id: z.string(),
  sourceRef: z.string().min(1),
  label: nullableString,
  stepKey: nullableString,
  campaignId: nullableString,
  orgId: nullableString,
  brandId: nullableString,
  socialPostId: nullableString,
  platform: z.string().min(1),
  postId: z.string(),
  postUrl: nullableString,
  kind: z.string().min(1),
  reactionType: nullableString,
  person: z.object({
    key: z.string().min(1),
    name: nullableString,
    handle: nullableString,
    profileUrl: nullableString,
    urn: nullableString,
    headline: nullableString,
  }),
  text: nullableString,
  url: nullableString,
  occurredAt: nullableString,
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});
export type SocialEngagementFact = z.infer<typeof SocialEngagementFactSchema>;

export class SocialEngagementsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocialEngagementsUnavailableError";
  }
}

/** The feed since an instant. An unreadable answer throws: never "nobody engaged". */
export async function fetchSocialEngagements(since: Date): Promise<SocialEngagementFact[]> {
  const url = new URL("/internal/social-engagements", SOCIAL_SERVICE_URL);
  url.searchParams.set("since", since.toISOString());
  url.searchParams.set("limit", String(SOCIAL_ENGAGEMENTS_PAGE_LIMIT));
  let res: Response;
  try {
    res = await fetchWithRetry(url.toString(), {
      headers: { "x-api-key": SOCIAL_SERVICE_API_KEY },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new SocialEngagementsUnavailableError(`social-service unreachable: ${(error as Error).message}`);
  }
  if (!res.ok) {
    throw new SocialEngagementsUnavailableError(`social-service answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const parsed = z.object({ engagements: z.array(SocialEngagementFactSchema) }).safeParse(await res.json());
  if (!parsed.success) {
    throw new SocialEngagementsUnavailableError(`social-service engagements unreadable: ${parsed.error.message.slice(0, 500)}`);
  }
  if (parsed.data.engagements.length >= SOCIAL_ENGAGEMENTS_PAGE_LIMIT) {
    console.error(
      `[lead-service] social engagements: the feed answered its ceiling (${SOCIAL_ENGAGEMENTS_PAGE_LIMIT}) since ${since.toISOString()}; older facts of the window were not read this pass`,
    );
  }
  return parsed.data.engagements;
}

const LABELS: ReadonlySet<string> = new Set(TIMELINE_ITEM_LABELS);

/** The timeline label a fact states (its label, else its step key), or null when the vocabulary lacks it. */
export function engagementLabel(fact: SocialEngagementFact): TimelineItemLabel | null {
  const label = fact.label ?? fact.stepKey;
  return label && LABELS.has(label) ? (label as TimelineItemLabel) : null;
}

/**
 * One fact, as its timeline row. `occurred_at` = when the person acted; a reaction carries no date on
 * LinkedIn, so it is dated when social-service first saw it (`detail.dated` says which).
 */
export function engagementRow(
  fact: SocialEngagementFact & { orgId: string; brandId: string },
  label: TimelineItemLabel,
  leadId: string,
  offers: ReadonlyMap<string, string | null>,
): TimelineFactRow {
  return {
    id: `social:${fact.sourceRef}`,
    org_id: fact.orgId,
    brand_id: fact.brandId,
    offer_id: fact.campaignId ? offers.get(fact.campaignId) ?? null : null,
    lead_id: leadId,
    campaign_id: fact.campaignId,
    occurred_at: fact.occurredAt ?? fact.firstSeenAt,
    label,
    source: "social",
    source_ref: fact.sourceRef,
    attributable: true,
    attribution_basis: "reaction_to_our_post",
    url: fact.url ?? fact.postUrl,
    detail: {
      platform: fact.platform,
      kind: fact.kind,
      reactionType: fact.reactionType,
      postId: fact.postId,
      socialPostId: fact.socialPostId,
      personKey: fact.person.key,
      dated: fact.occurredAt ? "occurred" : "first_seen",
    },
    withdrawn_at: null,
  };
}

export interface SocialIngestResult {
  received: number;
  /** Facts filed on a lead's timeline (written or already there). */
  filed: number;
  /** Rows actually written (new or changed). */
  written: number;
  /** Leads minted for people nobody held. */
  peopleCreated: number;
  /** Facts stating no org or brand yet. */
  unscoped: number;
  /** Facts whose label the timeline vocabulary does not hold. */
  unplaced: number;
}

/** File facts: one lead per person, one timeline row per fact. Throws when campaign offers are unreadable. */
export async function ingestSocialEngagements(facts: readonly SocialEngagementFact[]): Promise<SocialIngestResult> {
  const result: SocialIngestResult = { received: facts.length, filed: 0, written: 0, peopleCreated: 0, unscoped: 0, unplaced: 0 };
  const offersByOrg = new Map<string, ReadonlyMap<string, string | null>>();
  const rows: TimelineFactRow[] = [];
  for (const fact of facts) {
    const { orgId, brandId } = fact;
    if (!orgId || !brandId) {
      result.unscoped++;
      continue;
    }
    const label = engagementLabel(fact);
    if (!label) {
      result.unplaced++;
      continue;
    }
    let offers = offersByOrg.get(orgId);
    if (!offers) {
      offers = fact.campaignId ? await fetchOrgCampaignOffers({ orgId }) : new Map<string, string | null>();
      if (fact.campaignId) offersByOrg.set(orgId, offers);
    }
    const person: SocialPerson = fact.person;
    const { leadId, created } = await resolveSocialLead(socialIdentityOf(fact.platform, person), person);
    if (created) result.peopleCreated++;
    rows.push(engagementRow({ ...fact, orgId, brandId }, label, leadId, offers));
  }
  result.filed = rows.length;
  result.written = await upsertTimelineFacts(rows);
  return result;
}

/** One pass: read the feed's window and file it. */
export async function syncSocialEngagements(now: Date = new Date()): Promise<SocialIngestResult> {
  const facts = await fetchSocialEngagements(new Date(now.getTime() - SOCIAL_ENGAGEMENTS_WINDOW_MS));
  return ingestSocialEngagements(facts);
}

let sweeping = false;

export async function sweepSocialEngagements(): Promise<void> {
  if (sweeping) return;
  sweeping = true;
  try {
    const r = await syncSocialEngagements();
    if (r.written > 0 || r.peopleCreated > 0 || r.unplaced > 0) {
      console.log(
        `[lead-service] social engagements received=${r.received} filed=${r.filed} written=${r.written} ` +
          `peopleCreated=${r.peopleCreated} unscoped=${r.unscoped} unplaced=${r.unplaced}`,
      );
    }
  } catch (error) {
    console.error(`[lead-service] social engagements sweep failed, the facts not yet filed wait for the next pass: ${(error as Error).message}`);
  } finally {
    sweeping = false;
  }
}

export function startSocialEngagementsWorker(): void {
  const tick = () => {
    sweepSocialEngagements().catch((error) => console.error("[lead-service] social engagements sweep failed:", error));
  };
  setTimeout(tick, FIRST_SWEEP_DELAY_MS).unref();
  setInterval(tick, SOCIAL_ENGAGEMENTS_INTERVAL_MS).unref();
}
