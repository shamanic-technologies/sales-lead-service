import { sql } from "../db/index.js";
import { toIsoTimestamp, type RawTimestamp } from "./basic-leads.js";
import { SAME_ACT_WINDOW_MS } from "./meeting-attribution.js";

/**
 * EVERY MESSAGE WE SENT ONE PERSON, any channel, each with WHO WROTE IT (WRITTEN-BY-1019-SENDER, owner
 * 2026-10-19: a client may see, on every message sent on their behalf, which workflow version wrote it).
 * Consumer: features-service joins the workflow version to its model + tactic lines. INTERNAL read only:
 * no customer-facing read carries a workflow name or run id.
 *
 * Messages, read off the records this service already holds for the person (one rule, no channel branch):
 *   - `email_sent` / `reply_sent`: the CURRENT fact of each subject of the bronze outreach copy
 *     (`outreach_facts`, every address registered on the lead, org-scoped; a withdrawn subject is absent).
 *     `id` = the subject key = the timeline fact's id.
 *   - `message_out`: crm-service's fact copy (`crm_facts`, every Unibox channel: WhatsApp, LinkedIn, Gmail...),
 *     matched on the lead's addresses and phones; a withdrawn fact is absent. `id` = the crm fact id.
 *   - `followup_act`: a follow-up ledger `acted` row (the sending workflow's run recorded it) that no message
 *     above was paired with: the act IS the record of what that run sent.
 *
 * Who wrote it, strongest evidence first, never guessed:
 *   1. the copy says a PERSON sent it (`reply_sent` `sentBy: human`) -> `person`;
 *   2. a run RECORDED the act: the nearest ledger `acted` row of the same person within SAME_ACT_WINDOW_MS
 *      (10 min, the window meeting attribution pairs a mailbox copy with its act on), of the message's own
 *      campaign when the message names one, of a brand the message names -> that run (`recorded_act`);
 *   3. an email sent by a sequence -> the run HOLDING the person's `leads_campaigns` row of that campaign when it
 *      went out (latest re-point at or before the send, else the row's serve: the same rule as `emailSends` on
 *      timeline-journeys; never `workflow_slug` alone) -> `holding_run`;
 *   4. else `unknown` with the reason. An undated message is never paired.
 * `workflowSlug` is the run's x-workflow-slug as recorded (the versioned slug); null when the record predates
 * it (ledger rows before migration 0114): `runId` still names the run, resolvable at runs-service.
 *
 * WHICH LLM wrote it (BEST-TPL-LLM-1022-LS, owner 2026-10-22: workflows no longer fix their LLM, features-service
 * picks each leg's best LLM per send, so the version no longer implies the model): `llmAlias` is the alias the
 * acting run STATED when it recorded the act (`followup_actions.llm_alias`, migration 0119), on `recorded_act` only.
 * Never derived from the version or the run. Null with `llmAliasReason`:
 *   - `not_stated`: a recorded act whose run stated none (every act recorded before 0119 reads so);
 *   - `no_recorded_act`: the writer is not a recorded act (a person, a sequence email's holding run: the copy
 *     content-generation keeps names that model, or unknown).
 */

export type SentMessageKind = "email_sent" | "reply_sent" | "message_out" | "followup_act";

export type WrittenByBasis = "person" | "recorded_act" | "holding_run";

export type WrittenByUnknownReason = "no_recorded_run" | "undated";

export type LlmAliasUnknownReason = "not_stated" | "no_recorded_act";

export interface WrittenBy {
  by: "workflow" | "person" | "unknown";
  basis: WrittenByBasis | null;
  runId: string | null;
  workflowSlug: string | null;
  /** The campaign the writing run was dispatched for (the ledger's acting campaign, or the holding row's). */
  campaignId: string | null;
  /** holding_run only: `serve` or the re-point cause that handed the row to that run. */
  workflowSource: string | null;
  reason: WrittenByUnknownReason | null;
  /** The LLM alias the acting run stated it wrote this message with (recorded_act only); null = see llmAliasReason. */
  llmAlias: string | null;
  llmAliasReason: LlmAliasUnknownReason | null;
}

export interface SentMessage {
  id: string;
  kind: SentMessageKind;
  source: "outreach" | "crm" | "followup_ledger";
  /** `email` for outreach facts, crm's own channel name (whatsapp, linkedin, gmail...), null for a bare act. */
  channel: string | null;
  /** The campaign the record itself names (crm facts name none). */
  campaignId: string | null;
  brandIds: string[];
  sentAt: string | null;
  writtenBy: WrittenBy;
}

/** A message record before attribution (what the copies say). */
export interface MessageRecord {
  id: string;
  kind: Exclude<SentMessageKind, "followup_act">;
  source: "outreach" | "crm";
  channel: string | null;
  campaignId: string | null;
  brandIds: string[];
  sentAt: string | null;
  /** reply_sent only: the copy's `sentBy` (human | automation), null when it states none. */
  sentBy: string | null;
  /** email_sent only: the run holding the person's row of the campaign at the send; null = no row. */
  holding: { runId: string | null; workflowSlug: string | null; workflowSource: string } | null;
}

export interface LedgerAct {
  id: string;
  actingCampaignId: string | null;
  heldByCampaignId: string;
  runId: string | null;
  workflowSlug: string | null;
  /** The LLM alias the run stated on the act; null = none stated. */
  llmAlias: string | null;
  brandIds: string[];
  occurredAt: string;
}

const ms = (iso: string) => Date.parse(iso);

function nearestAct(m: MessageRecord, acts: readonly LedgerAct[]): LedgerAct | null {
  if (m.sentAt === null) return null;
  const at = ms(m.sentAt);
  let best: LedgerAct | null = null;
  for (const a of acts) {
    if (m.campaignId !== null && a.actingCampaignId !== m.campaignId) continue;
    if (m.brandIds.length > 0 && !a.brandIds.some((b) => m.brandIds.includes(b))) continue;
    const d = Math.abs(ms(a.occurredAt) - at);
    if (d > SAME_ACT_WINDOW_MS) continue;
    if (best === null || d < Math.abs(ms(best.occurredAt) - at) || (d === Math.abs(ms(best.occurredAt) - at) && a.id < best.id)) {
      best = a;
    }
  }
  return best;
}

function fromAct(a: LedgerAct): WrittenBy {
  return {
    by: "workflow",
    basis: "recorded_act",
    runId: a.runId,
    workflowSlug: a.workflowSlug,
    campaignId: a.actingCampaignId,
    workflowSource: null,
    reason: null,
    llmAlias: a.llmAlias,
    llmAliasReason: a.llmAlias === null ? "not_stated" : null,
  };
}

const UNKNOWN = (reason: WrittenByUnknownReason): WrittenBy => ({
  by: "unknown",
  basis: null,
  runId: null,
  workflowSlug: null,
  campaignId: null,
  workflowSource: null,
  reason,
  llmAlias: null,
  llmAliasReason: "no_recorded_act",
});

/** Attribute every message to its writer (pure); unpaired acts are listed as messages of their own. */
export function attributeSentMessages(records: readonly MessageRecord[], acts: readonly LedgerAct[]): SentMessage[] {
  const pairedActs = new Set<string>();
  const out: SentMessage[] = [];
  for (const m of records) {
    let writtenBy: WrittenBy;
    if (m.kind === "reply_sent" && m.sentBy === "human") {
      writtenBy = { ...UNKNOWN("no_recorded_run"), by: "person", basis: "person", reason: null };
    } else {
      const act = nearestAct(m, acts);
      if (act) {
        pairedActs.add(act.id);
        writtenBy = fromAct(act);
      } else if (m.kind === "email_sent" && m.holding && m.holding.workflowSlug !== null) {
        writtenBy = {
          by: "workflow",
          basis: "holding_run",
          runId: m.holding.runId,
          workflowSlug: m.holding.workflowSlug,
          campaignId: m.campaignId,
          workflowSource: m.holding.workflowSource,
          reason: null,
          llmAlias: null,
          llmAliasReason: "no_recorded_act",
        };
      } else {
        writtenBy = UNKNOWN(m.sentAt === null ? "undated" : "no_recorded_run");
      }
    }
    out.push({
      id: m.id,
      kind: m.kind,
      source: m.source,
      channel: m.channel,
      campaignId: m.campaignId,
      brandIds: m.brandIds,
      sentAt: m.sentAt,
      writtenBy,
    });
  }
  for (const a of acts) {
    if (pairedActs.has(a.id)) continue;
    out.push({
      id: a.id,
      kind: "followup_act",
      source: "followup_ledger",
      channel: null,
      campaignId: a.actingCampaignId,
      brandIds: a.brandIds,
      sentAt: a.occurredAt,
      writtenBy: fromAct(a),
    });
  }
  return out.sort(
    (x, y) =>
      (x.sentAt === null ? Infinity : ms(x.sentAt)) - (y.sentAt === null ? Infinity : ms(y.sentAt)) ||
      x.id.localeCompare(y.id),
  );
}

interface RawOutreach {
  subject_key: string;
  type: string;
  occurred_at: RawTimestamp;
  campaign_id: string | null;
  brand_ids: string[];
  sent_by: string | null;
  holding_run_id: string | null;
  holding_workflow_slug: string | null;
  holding_source: string | null;
}

interface RawCrm {
  fact_id: string;
  occurred_at: RawTimestamp;
  brand_id: string;
  channel: string | null;
}

interface RawAct {
  id: string;
  acting_campaign_id: string | null;
  held_by_campaign_id: string;
  run_id: string | null;
  workflow_slug: string | null;
  llm_alias: string | null;
  brand_ids: string[];
  occurred_at: RawTimestamp;
}

/** True when the lead is a lead of this org (holds a lifecycle row of it). */
export async function leadBelongsToOrg(orgId: string, leadId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM leads_campaigns WHERE lead_id = ${leadId}::uuid AND org_id = ${orgId} LIMIT 1
  `) as unknown as unknown[];
  return rows.length > 0;
}

/** Every message we sent the lead at the org, each attributed (see the module doc). */
export async function readSentMessages(orgId: string, leadId: string): Promise<SentMessage[]> {
  const [outreach, crm, acts] = await Promise.all([
    sql`
      WITH emails AS (
        SELECT DISTINCT lower(value) AS v FROM lead_contact_methods WHERE lead_id = ${leadId}::uuid AND channel = 'email'
      ), current AS (
        SELECT DISTINCT ON (o.subject_key) o.subject_key, o.type, o.occurred_at, o.campaign_id, o.brand_ids, o.raw
        FROM outreach_facts o
        WHERE o.org_id = ${orgId} AND o.lead_email IN (SELECT v FROM emails)
        ORDER BY o.subject_key, o.seq DESC
      )
      SELECT c.subject_key, c.type, c.occurred_at, c.campaign_id, c.brand_ids,
        c.raw->'replySent'->>'sentBy' AS sent_by,
        CASE WHEN lc.id IS NULL THEN NULL WHEN rp.cause IS NOT NULL THEN rp.run_id ELSE lc.run_id END AS holding_run_id,
        CASE WHEN lc.id IS NULL THEN NULL WHEN rp.cause IS NOT NULL THEN rp.workflow_slug ELSE lc.workflow_slug END AS holding_workflow_slug,
        CASE WHEN lc.id IS NULL THEN NULL WHEN rp.cause IS NOT NULL THEN rp.cause ELSE 'serve' END AS holding_source
      FROM current c
      LEFT JOIN leads_campaigns lc
        ON c.type = 'email_sent' AND lc.lead_id = ${leadId}::uuid AND lc.campaign_id = c.campaign_id AND lc.org_id = ${orgId}
      LEFT JOIN LATERAL (
        SELECT r.run_id, r.workflow_slug, r.cause FROM lead_campaign_run_repoints r
        WHERE r.lead_campaign_id = lc.id AND r.repointed_at <= c.occurred_at
        ORDER BY r.repointed_at DESC, r.id DESC
        LIMIT 1
      ) rp ON true
      WHERE c.type IN ('email_sent', 'reply_sent')
    ` as unknown as Promise<RawOutreach[]>,
    sql`
      WITH emails AS (
        SELECT DISTINCT lower(value) AS v FROM lead_contact_methods WHERE lead_id = ${leadId}::uuid AND channel = 'email'
      ), phones AS (
        SELECT DISTINCT regexp_replace(value, '[[:space:]()./-]', '', 'g') AS v
        FROM lead_contact_methods WHERE lead_id = ${leadId}::uuid AND channel = 'phone'
      )
      SELECT f.fact_id, f.occurred_at, f.brand_id, f.payload->>'channel' AS channel
      FROM crm_facts f
      WHERE f.org_id = ${orgId} AND f.type = 'message_out'
        AND (
          EXISTS (SELECT 1 FROM unnest(f.emails) e WHERE lower(e) IN (SELECT v FROM emails))
          OR EXISTS (SELECT 1 FROM unnest(f.phones) p WHERE regexp_replace(p, '[[:space:]()./-]', '', 'g') IN (SELECT v FROM phones))
        )
        AND NOT EXISTS (
          SELECT 1 FROM crm_facts w WHERE w.org_id = f.org_id AND w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id
        )
    ` as unknown as Promise<RawCrm[]>,
    sql`
      SELECT id::text AS id, acting_campaign_id, held_by_campaign_id, run_id, workflow_slug, llm_alias, brand_ids, occurred_at
      FROM followup_actions
      WHERE lead_id = ${leadId}::uuid AND org_id = ${orgId} AND action = 'acted'
    ` as unknown as Promise<RawAct[]>,
  ]);

  const records: MessageRecord[] = [
    ...outreach.map((r): MessageRecord => ({
      id: r.subject_key,
      kind: r.type as "email_sent" | "reply_sent",
      source: "outreach",
      channel: "email",
      campaignId: r.campaign_id,
      brandIds: r.brand_ids ?? [],
      sentAt: toIsoTimestamp(r.occurred_at),
      sentBy: r.type === "reply_sent" ? r.sent_by : null,
      holding:
        r.holding_source === null
          ? null
          : { runId: r.holding_run_id, workflowSlug: r.holding_workflow_slug, workflowSource: r.holding_source },
    })),
    ...crm.map((r): MessageRecord => ({
      id: r.fact_id,
      kind: "message_out",
      source: "crm",
      channel: r.channel && r.channel.length > 0 ? r.channel : null,
      campaignId: null,
      brandIds: [r.brand_id],
      sentAt: toIsoTimestamp(r.occurred_at),
      sentBy: null,
      holding: null,
    })),
  ];
  const ledger: LedgerAct[] = acts.map((a) => ({
    id: a.id,
    actingCampaignId: a.acting_campaign_id,
    heldByCampaignId: a.held_by_campaign_id,
    runId: a.run_id,
    workflowSlug: a.workflow_slug,
    llmAlias: a.llm_alias,
    brandIds: a.brand_ids ?? [],
    occurredAt: toIsoTimestamp(a.occurred_at) as string,
  }));
  return attributeSentMessages(records, ledger);
}
