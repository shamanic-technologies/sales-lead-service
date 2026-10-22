/**
 * Every served row of a campaign whose pipe does not write by email carries the mark of what its sender sent
 * (`channel_sent_at`/`channel_send_id`), whether the campaign still serves or not (WA-SENDS-BATCH-1014).
 *
 * The paid-pool retry (retry-pool.ts) writes that mark only when a campaign's pool reads a row, which happens only
 * while the campaign serves. A STOPPED campaign is never read again, so its rows stayed unmarked for good and every
 * "contacted" read (the Leads page tiles, features-service's count for non-email pipes) showed 0 (campaign 4af21454
 * "Valued", stopped 2026-10-13: 12 served rows, 0 marked, while crm-service held 8 people `sent` on it).
 *
 * This walk asks the sender, ONE `sends/query` call per campaign batch (channel-send-client.ts), and writes the mark
 * by the same rule as the pool (`decideChannelRetry`: only THIS campaign's `sent` sends; the earliest wins). Nothing
 * else is written: `sending`, `failed`, `refused` or no send leave the row as it is. Idempotent (the UPDATE is guarded
 * on `channel_sent_at IS NULL`).
 *
 * A send crm-service holds with NO email (phone only) cannot be matched: the batch read is by email, and a row with no
 * email is never asked. Such rows are counted (`noEmail`) and logged, never guessed.
 *
 * Runs on the background thread (`startChannelSendReconcileWorker`) over rows served in the last
 * `RECONCILE_WINDOW_MS`; `reconcileChannelSends({ servedSince: null })` walks every age (the one-time pass).
 */
import { messageOf } from "./db-error.js";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { channelSendKey, ChannelSendsUnavailableError, fetchChannelSendsBatch } from "./channel-send-client.js";
import { channelReachableBy } from "./channel-reach.js";
import { listChannelsWithContactMethods } from "./sourcing-origin.js";
import { decideChannelRetry, markChannelSentCandidates, poolSenderOf } from "./retry-pool.js";

export const CHANNEL_SEND_RECONCILE_INTERVAL_MS = 15 * 60_000;
const FIRST_DELAY_MS = 90_000;
/** A WhatsApp send lands minutes after the serve; a row older than this was settled by an earlier tick. */
export const RECONCILE_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** People per `sends/query` call (crm-service takes up to 500). */
export const RECONCILE_BATCH_SIZE = 200;

export interface UnmarkedRow {
  id: string;
  org_id: string;
  campaign_id: string;
  feature_slug: string | null;
  brand_ids: string[] | null;
  user_id: string | null;
  email: string | null;
}

export interface CampaignReconcile {
  campaignId: string;
  rows: number;
  marked: number;
  noEmail: number;
  /** Why the campaign was not asked (unreadable sender, several brands on a row), else null. */
  skipped: string | null;
}

export interface ReconcileResult {
  dryRun: boolean;
  campaigns: CampaignReconcile[];
  rows: number;
  marked: number;
  noEmail: number;
  failedCampaigns: number;
}

/**
 * The channels whose pool asks the non-email sender: the pool's own rule (`poolSenderOf(channelReachableBy(slug))`)
 * over every channel the catalogue states contact methods for. A channel stating none is an email pool.
 */
export async function nonEmailChannels(): Promise<string[]> {
  const out: string[] = [];
  for (const slug of await listChannelsWithContactMethods()) {
    if (poolSenderOf(await channelReachableBy(slug)) === "channel") out.push(slug);
  }
  return out.sort();
}

/** Served rows of these channels not yet marked, with the person's first email (the pool's own choice of address). */
export async function loadUnmarkedServedRows(channels: readonly string[], servedSince: Date | null): Promise<UnmarkedRow[]> {
  if (channels.length === 0) return [];
  const since = servedSince ? sql`AND lc.served_at >= ${servedSince.toISOString()}` : sql``;
  return (await db.execute(sql`
    SELECT lc.id, lc.org_id, lc.campaign_id, lc.feature_slug, lc.brand_ids, lc.user_id, em.value AS email
    FROM leads_campaigns lc
    LEFT JOIN LATERAL (
      SELECT cm.value
      FROM lead_contact_methods cm
      WHERE cm.lead_id = lc.lead_id AND cm.channel = 'email'
      ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
      LIMIT 1
    ) em ON true
    WHERE lc.status = 'served'
      AND lc.channel_sent_at IS NULL
      AND lc.feature_slug IN (${sql.join(channels.map((c) => sql`${c}`), sql`, `)})
      ${since}
    ORDER BY lc.campaign_id, lc.served_at ASC, lc.id ASC
  `)) as unknown as UnmarkedRow[];
}

/** PURE: group rows by campaign (one sender question per campaign). */
export function groupByCampaign(rows: readonly UnmarkedRow[]): Map<string, UnmarkedRow[]> {
  const out = new Map<string, UnmarkedRow[]>();
  for (const r of rows) {
    const list = out.get(r.campaign_id) ?? [];
    list.push(r);
    out.set(r.campaign_id, list);
  }
  return out;
}

async function reconcileCampaign(campaignId: string, rows: UnmarkedRow[], dryRun: boolean, nowMs: number): Promise<CampaignReconcile> {
  const out: CampaignReconcile = { campaignId, rows: rows.length, marked: 0, noEmail: 0, skipped: null };
  const brands = new Set(rows.flatMap((r) => r.brand_ids ?? []));
  const orgs = new Set(rows.map((r) => r.org_id));
  if (brands.size !== 1 || orgs.size !== 1) {
    out.skipped = `campaign rows name ${brands.size} brand(s) and ${orgs.size} org(s), the sender is asked for exactly one of each`;
    return out;
  }
  const [brandId] = [...brands];
  const [orgId] = [...orgs];
  const userId = [...rows].reverse().find((r) => r.user_id)?.user_id ?? null;

  const withEmail = rows.filter((r): r is UnmarkedRow & { email: string } => Boolean(r.email));
  out.noEmail = rows.length - withEmail.length;
  for (let i = 0; i < withEmail.length; i += RECONCILE_BATCH_SIZE) {
    const batch = withEmail.slice(i, i + RECONCILE_BATCH_SIZE);
    const sends = await fetchChannelSendsBatch(brandId, campaignId, batch.map((r) => r.email), { orgId, userId });
    const sent: Array<{ id: string; sentAt: string; sendId: string }> = [];
    for (const r of batch) {
      const decided = decideChannelRetry(sends.get(channelSendKey(r.email)), campaignId, nowMs);
      if (decided.verdict === "channel_sent") sent.push({ id: r.id, sentAt: decided.sentAt, sendId: decided.sendId });
    }
    if (!dryRun) await markChannelSentCandidates(sent, nowMs);
    out.marked += sent.length;
  }
  return out;
}

/**
 * Asks the sender about every unmarked served row of every campaign whose pipe does not write by email, and marks
 * the ones it states sent. `dryRun` asks and counts, writes nothing. One campaign failing never stops the others.
 */
export async function reconcileChannelSends(opts: { servedSince: Date | null; dryRun?: boolean; nowMs?: number }): Promise<ReconcileResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const dryRun = opts.dryRun ?? false;
  const result: ReconcileResult = { dryRun, campaigns: [], rows: 0, marked: 0, noEmail: 0, failedCampaigns: 0 };

  const channelRows = await loadUnmarkedServedRows(await nonEmailChannels(), opts.servedSince);

  for (const [campaignId, campaignRows] of groupByCampaign(channelRows)) {
    let done: CampaignReconcile;
    try {
      done = await reconcileCampaign(campaignId, campaignRows, dryRun, nowMs);
    } catch (err) {
      if (!(err instanceof ChannelSendsUnavailableError)) throw err;
      done = { campaignId, rows: campaignRows.length, marked: 0, noEmail: 0, skipped: messageOf(err) };
      result.failedCampaigns += 1;
    }
    result.campaigns.push(done);
    result.rows += done.rows;
    result.marked += done.marked;
    result.noEmail += done.noEmail;
  }
  return result;
}

export function logReconcile(result: ReconcileResult, label: string): void {
  for (const c of result.campaigns) {
    if (c.skipped) {
      console.warn(`[lead-service] channel-send reconcile${label} campaign=${c.campaignId} rows=${c.rows} not asked: ${c.skipped}`);
    } else if (c.marked > 0 || c.noEmail > 0) {
      console.log(
        `[lead-service] channel-send reconcile${label} campaign=${c.campaignId} rows=${c.rows} ${result.dryRun ? "would mark" : "marked"}=${c.marked} noEmail=${c.noEmail}`,
      );
    }
  }
  if (result.marked > 0 || result.failedCampaigns > 0 || result.dryRun) {
    console.log(
      `[lead-service] channel-send reconcile${label} done dryRun=${result.dryRun} campaigns=${result.campaigns.length} rows=${result.rows} ${result.dryRun ? "wouldMark" : "marked"}=${result.marked} noEmail=${result.noEmail} failedCampaigns=${result.failedCampaigns}`,
    );
  }
}

let running = false;

export function startChannelSendReconcileWorker(): void {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      logReconcile(await reconcileChannelSends({ servedSince: new Date(Date.now() - RECONCILE_WINDOW_MS) }), "");
    } catch (err) {
      console.error("[lead-service] channel-send reconcile tick failed:", err);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), FIRST_DELAY_MS).unref();
  setInterval(() => void tick(), CHANNEL_SEND_RECONCILE_INTERVAL_MS).unref();
}
