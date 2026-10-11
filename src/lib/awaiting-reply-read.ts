/**
 * The IO of "who is waiting on us" (`awaiting-reply.ts` is the pure rule): reads one brand's
 * conversations off the outreach fact copy (`outreach_facts`, current fact per subject: a correction
 * supersedes, a withdrawal ends it) and the "answered outside" statements, groups them per PERSON
 * (lead, through the registered email), and hydrates the people waiting with the lifecycle row the
 * dashboard opens and their name.
 *
 * Freshness: the copy is pulled every 2 minutes, so an answer through our mailboxes takes the person
 * out within minutes; a statement is on the very next read. FAIL LOUD: a copy that has never reached
 * the feed's end once would read every answer as missing, so the read refuses (OutreachCopyNotReadyError).
 */
import { sql } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { loadOutreachFeedState } from "./outreach-fact-feed.js";
import { replyLabel, type PlaceableJudgments, type PlaceableVerdict } from "./timeline-labels.js";
import { awaitingReplyOf, type AnswerVia, type AwaitingReply, type ConversationEvent } from "./awaiting-reply.js";

export class OutreachCopyNotReadyError extends Error {
  constructor() {
    super("the outreach fact copy has not reached the feed's end yet: answers of ours could be missing");
    this.name = "OutreachCopyNotReadyError";
  }
}

export interface AwaitingPerson extends AwaitingReply {
  /** The lifecycle row (`leads_campaigns.id`) the dashboard opens: the one the latest message came on. */
  id: string | null;
  leadId: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
}

interface FactRow {
  type: string;
  subject_key: string;
  occurred_at: Date | string | null;
  lead_email: string;
  campaign_id: string | null;
  raw: Record<string, unknown>;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

const VIAS: ReadonlySet<string> = new Set(["replies_route", "staff_client", "provider_unibox"]);

/** One current fact as a conversation event; null when it says nothing about who waits on whom. */
export function factEvent(fact: FactRow): ConversationEvent | null {
  const at = toIsoTimestamp(fact.occurred_at);
  if (at === null) return null;
  switch (fact.type) {
    case "reply_sent": {
      const via = obj(fact.raw.replySent)?.via;
      return { type: "answer", at, via: typeof via === "string" && VIAS.has(via) ? (via as AnswerVia) : "unknown" };
    }
    case "unsubscribed":
      return { type: "opt_out", at };
    case "reply": {
      const reply = obj(fact.raw.reply);
      if (!reply) return null;
      const label = replyLabel(obj(reply.verdict) as unknown as PlaceableVerdict | null, obj(reply.judgments) as PlaceableJudgments | null);
      if (label === null) return null;
      if (label === "opt_out") return { type: "opt_out", at };
      return {
        type: "inbound",
        at,
        label,
        campaignId: fact.campaign_id,
        subject: typeof reply.subject === "string" ? reply.subject : null,
        ref: fact.subject_key,
      };
    }
    default:
      return null;
  }
}

async function readConversationFacts(orgId: string, brandId: string): Promise<FactRow[]> {
  return (await sql`
    SELECT type, subject_key, occurred_at, lead_email, campaign_id, raw FROM (
      SELECT DISTINCT ON (subject_key) type, subject_key, occurred_at, lead_email, campaign_id, raw
      FROM outreach_facts
      WHERE org_id = ${orgId} AND brand_ids @> ARRAY[${brandId}]::text[]
        AND type IN ('reply', 'reply_sent', 'unsubscribed', 'withdrawn')
      ORDER BY subject_key, seq DESC
    ) current
    WHERE type <> 'withdrawn'
  `) as unknown as FactRow[];
}

async function readLeadsByEmail(emails: readonly string[]): Promise<Map<string, string>> {
  if (emails.length === 0) return new Map();
  const rows = (await sql`
    SELECT lower(value) AS email, lead_id::text AS lead_id
    FROM lead_contact_methods
    WHERE channel = 'email' AND lower(value) IN (SELECT jsonb_array_elements_text(${JSON.stringify(emails)}::jsonb))
  `) as unknown as Array<{ email: string; lead_id: string }>;
  return new Map(rows.map((r) => [r.email, r.lead_id]));
}

async function readStatements(orgId: string, brandId: string): Promise<Array<{ lead_id: string; stated_at: Date | string }>> {
  return (await sql`
    SELECT lead_id::text AS lead_id, stated_at
    FROM answered_outside_statements
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
  `) as unknown as Array<{ lead_id: string; stated_at: Date | string }>;
}

interface HydrationRow {
  lead_id: string;
  row_id: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  name: string | null;
}

/** Per lead: the row the latest message came on (else the newest row at the brand) and the name. */
async function hydrate(
  orgId: string,
  brandId: string,
  wanted: ReadonlyArray<{ leadId: string; campaignId: string | null }>,
): Promise<Map<string, HydrationRow>> {
  if (wanted.length === 0) return new Map();
  const rows = (await sql`
    SELECT w.lead_id, lc.id::text AS row_id, canonical.email, l.first_name, l.last_name, l.name
    FROM jsonb_to_recordset(${JSON.stringify(wanted.map((w) => ({ lead_id: w.leadId, campaign_id: w.campaignId })))}::jsonb)
      AS w(lead_id text, campaign_id text)
    JOIN leads l ON l.id = w.lead_id::uuid
    LEFT JOIN LATERAL (
      SELECT x.id FROM leads_campaigns x
      WHERE x.lead_id = l.id AND x.org_id = ${orgId} AND x.brand_ids @> ARRAY[${brandId}]::text[]
      ORDER BY (x.campaign_id = w.campaign_id) DESC NULLS LAST, x.served_at DESC NULLS LAST, x.created_at DESC, x.id
      LIMIT 1
    ) lc ON true
    LEFT JOIN LATERAL (
      SELECT lower(cm.value) AS email FROM lead_contact_methods cm
      WHERE cm.lead_id = l.id AND cm.channel = 'email'
      ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
      LIMIT 1
    ) canonical ON true
  `) as unknown as HydrationRow[];
  return new Map(rows.map((r) => [r.lead_id, r]));
}

/**
 * Every person waiting on us at the brand, oldest wait first. `leadIds` narrows the answer to those
 * people (the statement write reads one person back).
 */
export async function readAwaitingReply(input: {
  orgId: string;
  brandId: string;
  leadIds?: readonly string[];
}): Promise<AwaitingPerson[]> {
  const { orgId, brandId } = input;
  const state = await loadOutreachFeedState();
  if (!state.caughtUp) throw new OutreachCopyNotReadyError();

  const [facts, statements] = await Promise.all([readConversationFacts(orgId, brandId), readStatements(orgId, brandId)]);
  const leadByEmail = await readLeadsByEmail([...new Set(facts.map((f) => f.lead_email.toLowerCase()))]);
  const only = input.leadIds ? new Set(input.leadIds) : null;

  const events = new Map<string, ConversationEvent[]>();
  const push = (leadId: string, e: ConversationEvent) => {
    if (only && !only.has(leadId)) return;
    const list = events.get(leadId);
    if (list) list.push(e);
    else events.set(leadId, [e]);
  };
  for (const fact of facts) {
    const leadId = leadByEmail.get(fact.lead_email.toLowerCase());
    if (!leadId) continue;
    const e = factEvent(fact);
    if (e) push(leadId, e);
  }
  for (const s of statements) {
    const at = toIsoTimestamp(s.stated_at);
    if (at !== null) push(s.lead_id, { type: "answer", at, via: "answered_outside" });
  }

  const waiting: Array<{ leadId: string; state: AwaitingReply }> = [];
  for (const [leadId, list] of events) {
    const state = awaitingReplyOf(list);
    if (state) waiting.push({ leadId, state });
  }
  const hydrated = await hydrate(
    orgId,
    brandId,
    waiting.map((w) => ({ leadId: w.leadId, campaignId: w.state.lastMessage.campaignId })),
  );
  const emailOf = new Map<string, string>();
  for (const [email, leadId] of leadByEmail) if (!emailOf.has(leadId)) emailOf.set(leadId, email);

  return waiting
    .map(({ leadId, state }) => {
      const h = hydrated.get(leadId);
      return {
        id: h?.row_id ?? null,
        leadId,
        email: h?.email ?? emailOf.get(leadId) ?? "",
        firstName: h?.first_name ?? null,
        lastName: h?.last_name ?? null,
        name: h?.name ?? null,
        ...state,
      };
    })
    .sort((a, b) => Date.parse(a.waitingSince) - Date.parse(b.waitingSince) || a.leadId.localeCompare(b.leadId));
}

/** Record "I answered this person outside the platform". Append-only. */
export async function recordAnsweredOutside(input: {
  orgId: string;
  brandId: string;
  leadId: string;
  leadCampaignId: string;
  statedByUserId: string | null;
}): Promise<{ id: string; statedAt: string }> {
  const rows = (await sql`
    INSERT INTO answered_outside_statements (org_id, brand_id, lead_id, lead_campaign_id, stated_by_user_id)
    VALUES (${input.orgId}, ${input.brandId}, ${input.leadId}::uuid, ${input.leadCampaignId}::uuid, ${input.statedByUserId})
    RETURNING id::text AS id, stated_at
  `) as unknown as Array<{ id: string; stated_at: Date | string }>;
  return { id: rows[0].id, statedAt: toIsoTimestamp(rows[0].stated_at)! };
}
