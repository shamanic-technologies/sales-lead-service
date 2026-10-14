import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { DEFAULT_EMAIL_POLICY, EMAIL_POLICIES, type EmailPolicy } from "./email-policy.js";

/**
 * THE CATCH-ALL CHOICE IS MADE WHERE THE EMAIL IS CHECKED: AT THE FIND (CATCHALL-NEVER-SOURCED-1014, owner 2026-10-14).
 *
 * A source unit finds on its own (src/lib/source-mode.ts) and human-service checks each address at that find. The
 * pipe after it (cold email) serves the source's STOCK and never asks human-service, so the email policy it states
 * (`acceptedEmails`, src/lib/email-policy.ts) used to reach nobody who checks emails: the source kept asking valid
 * only, and a "Valid + Catch-all" funnel answered `source_stock_empty` forever while thousands of catch-all people
 * already revealed and paid for sat unused (Doc Dinners Catalyze, Olive Chivalry, 2026-10-13).
 *
 * Rule, every source and every pipe alike: each stock ask RECORDS the policy the asking pipe stated, per source it
 * reads (`source_email_demands`, its latest word); the source unit's own run asks human-service for the WIDEST policy
 * its pipes state (or the one its own workflow states, if wider). Nothing is guessed from a funnel id or a workflow
 * name: what a pipe asks is the fact. The stock still hands each pipe only addresses ITS policy accepts
 * (src/lib/reach-sql.ts), so a valid-only pipe never gets a catch-all person whatever its source holds.
 */

/** PURE: the widest of several policies (`valid_and_catch_all` accepts everything `valid_only` does). Null = none stated. */
export function widestEmailPolicy(policies: ReadonlyArray<EmailPolicy | null | undefined>): EmailPolicy | null {
  let widest: EmailPolicy | null = null;
  for (const p of policies) {
    if (!p) continue;
    if (p === "valid_and_catch_all") return p;
    widest = p;
  }
  return widest;
}

/** Records, per source the pipe reads, the policy it stated on this ask (absent = the default, valid only). */
export async function recordSourceEmailDemand(params: {
  sourceCampaignIds: readonly string[];
  outreachCampaignId: string;
  acceptedEmails: EmailPolicy | null | undefined;
}): Promise<void> {
  if (params.sourceCampaignIds.length === 0) return;
  const policy = params.acceptedEmails ?? DEFAULT_EMAIL_POLICY;
  await db.execute(sql`
    INSERT INTO source_email_demands (source_campaign_id, outreach_campaign_id, accepted_emails, asked_at)
    SELECT s, ${params.outreachCampaignId}, ${policy}, now() FROM unnest(${sql.param([...params.sourceCampaignIds])}::text[]) AS s
    ON CONFLICT (source_campaign_id, outreach_campaign_id)
    DO UPDATE SET accepted_emails = EXCLUDED.accepted_emails, asked_at = EXCLUDED.asked_at
  `);
}

/** The policies the pipes fed by this source last stated. Throws on a value outside the vocabulary. */
export async function loadSourceEmailDemands(sourceCampaignId: string): Promise<EmailPolicy[]> {
  const rows = (await db.execute(sql`
    SELECT accepted_emails FROM source_email_demands WHERE source_campaign_id = ${sourceCampaignId}
  `)) as unknown as Array<{ accepted_emails: string }>;
  return rows.map((r) => {
    if (!(EMAIL_POLICIES as readonly string[]).includes(r.accepted_emails)) {
      throw new Error(`[source-email-demand] unknown policy "${r.accepted_emails}" recorded for source ${sourceCampaignId}`);
    }
    return r.accepted_emails as EmailPolicy;
  });
}

/**
 * The policy a source unit's own run asks human-service with: the widest of its own workflow's word and its pipes'.
 * Pipes stating valid only change nothing on the wire (the run's own word, or nothing, as before).
 */
export async function sourceRunEmailPolicy(sourceCampaignId: string, stated: EmailPolicy | null | undefined): Promise<EmailPolicy | null> {
  const widest = widestEmailPolicy([stated, ...(await loadSourceEmailDemands(sourceCampaignId))]);
  return widest === "valid_and_catch_all" ? widest : (stated ?? null);
}
