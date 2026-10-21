/**
 * OUR FIRST TOUCH of a person at a brand, on ANY channel one of our pipes sends on (owner 2026-10-21: the pipeline
 * counts every outcome any of our campaigns / sales funnels / pipes caused, on any channel, and excludes only what
 * came on its own).
 *
 * The whose-win rule (`crmCauseRule`, `outcomeCauseRule`) compares an outcome's date with our first touch. It used to
 * read email-gateway alone, so a person a WhatsApp pipe wrote to read "never delivered" and their signup stayed
 * undecided forever (distribute.you 2026-10-21: 8 signups written on WhatsApp by a pipe, all undecided).
 *
 * Two records, both of a PIPE's send, never a person's hand-written message:
 *   - email: email-gateway's first delivered email at brand scope (asked by the caller, unchanged);
 *   - every other channel: `leads_campaigns.channel_sent_at`, the mark the non-email sender's own record wrote on the
 *     lead's served row (crm-service's `sent` send, channel-send-reconcile.ts / retry-pool.ts), keyed by lead id: no
 *     address or name matching here.
 * The first touch is the earliest of the two. A Unibox message typed by a person (crm `message_out`) is not a pipe's
 * send and is not read.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";

/** Our first non-email pipe send to each lead at (org, brand); a lead with none is absent. */
export async function firstChannelSends(
  orgId: string,
  brandId: string,
  leadIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (leadIds.length === 0) return out;
  const rows = (await db.execute(sql`
    SELECT lead_id::text AS lead_id, min(channel_sent_at) AS first_sent_at
    FROM leads_campaigns
    WHERE lead_id = ANY(${sql.param([...leadIds])}::uuid[])
      AND org_id = ${orgId}
      AND ${brandId} = ANY(brand_ids)
      AND channel_sent_at IS NOT NULL
    GROUP BY lead_id
  `)) as unknown as Array<{ lead_id: string; first_sent_at: Date | string | null }>;
  for (const r of rows) {
    const at = toIsoTimestamp(r.first_sent_at);
    if (at) out.set(r.lead_id, at);
  }
  return out;
}

/** PURE: the earliest of our first delivered email and our first non-email pipe send. */
export function firstTouchAt(firstDeliveredEmailAt: string | null, firstChannelSentAt: string | null): string | null {
  if (!firstDeliveredEmailAt) return firstChannelSentAt;
  if (!firstChannelSentAt) return firstDeliveredEmailAt;
  // Compared as instants: the two records format their timestamps independently.
  return Date.parse(firstChannelSentAt) < Date.parse(firstDeliveredEmailAt) ? firstChannelSentAt : firstDeliveredEmailAt;
}

/** Folds every lead's non-email first send into an email-delivery map (missing leads read as never emailed). */
export async function withFirstChannelSends(
  orgId: string,
  brandId: string,
  leadIds: readonly string[],
  emailDelivered: ReadonlyMap<string, string | null>,
): Promise<Map<string, string | null>> {
  const channel = await firstChannelSends(orgId, brandId, leadIds);
  const out = new Map<string, string | null>();
  for (const id of leadIds) out.set(id, firstTouchAt(emailDelivered.get(id) ?? null, channel.get(id) ?? null));
  return out;
}
