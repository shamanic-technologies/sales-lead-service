import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { DEFAULT_EMAIL_POLICY, type EmailPolicy } from "./email-policy.js";

/**
 * A SOURCE UNIT'S WALK REMEMBERS WHO JUST ANSWERED NOBODY (CATCHALL-NEVER-SOURCED-1014, owner 2026-10-14: "Lead
 * Sourcing must not stick on one dry source").
 *
 * A source unit's own run walks its audiences one by one (src/lib/buffer.ts, find mode) and its caller leaves after
 * five minutes. Doc Dinners' Lead Sourcing unit walks 40 audiences at ~8s each: in the same order every run, the dry
 * audiences at the head (competitor pages with no recent posts, Apollo filters with nobody left) ate the whole budget
 * and the audiences behind them were never asked, run after run.
 *
 * Each audience's empty answer (exhausted, no recent posts, not serveable) is recorded per (source unit, audience,
 * email policy); a serve from it clears it. The walk asks every audience with no such answer first, then the ones that
 * answered nobody, the OLDEST answer first: an ORDER, never a skip, so a dry audience is still asked when the walk
 * reaches it, and successive runs cover the whole list. Keyed on the policy because an audience dry for valid emails
 * may hold catch-all people (already revealed and paid for) for a pipe that accepts them.
 */

/** `stalled` = human-service never answered a call for this audience (DOCDINNERS-SERVE-TIMEOUT-1027): ordered last like a dry one. */
export type EmptyAnswer = "exhausted" | "no_recent_posts" | "not_serveable" | "stalled";

/** When each audience last answered nobody to this source under this policy (ms since epoch). */
export async function loadEmptyAnswers(sourceCampaignId: string, acceptedEmails: EmailPolicy | null | undefined): Promise<Map<string, number>> {
  const policy = acceptedEmails ?? DEFAULT_EMAIL_POLICY;
  const rows = (await db.execute(sql`
    SELECT audience_id, last_empty_at::text AS at FROM source_audience_walks
     WHERE source_campaign_id = ${sourceCampaignId} AND accepted_emails = ${policy}
  `)) as unknown as Array<{ audience_id: string; at: string }>;
  return new Map(rows.map((r) => [r.audience_id, Date.parse(r.at)]));
}

export async function recordEmptyAnswer(params: {
  sourceCampaignId: string;
  audienceId: string;
  acceptedEmails: EmailPolicy | null | undefined;
  reason: EmptyAnswer;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO source_audience_walks (source_campaign_id, audience_id, accepted_emails, last_empty_at, last_empty_reason)
    VALUES (${params.sourceCampaignId}, ${params.audienceId}, ${params.acceptedEmails ?? DEFAULT_EMAIL_POLICY}, now(), ${params.reason})
    ON CONFLICT (source_campaign_id, audience_id, accepted_emails)
    DO UPDATE SET last_empty_at = EXCLUDED.last_empty_at, last_empty_reason = EXCLUDED.last_empty_reason
  `);
}

/** The audience served somebody: it goes back with the audiences nobody saw run dry. */
export async function clearEmptyAnswer(params: { sourceCampaignId: string; audienceId: string; acceptedEmails: EmailPolicy | null | undefined }): Promise<void> {
  await db.execute(sql`
    DELETE FROM source_audience_walks
     WHERE source_campaign_id = ${params.sourceCampaignId} AND audience_id = ${params.audienceId}
       AND accepted_emails = ${params.acceptedEmails ?? DEFAULT_EMAIL_POLICY}
  `);
}

/** PURE: audiences with no recorded empty answer first (their order kept), then the empty ones, oldest answer first. */
export function orderByEmptyAnswers(audienceIds: readonly string[], emptyAt: ReadonlyMap<string, number>): string[] {
  const fresh = audienceIds.filter((id) => !emptyAt.has(id));
  const dry = audienceIds
    .map((id, i) => ({ id, i, at: emptyAt.get(id) }))
    .filter((a): a is { id: string; i: number; at: number } => a.at !== undefined)
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((a) => a.id);
  return [...fresh, ...dry];
}
