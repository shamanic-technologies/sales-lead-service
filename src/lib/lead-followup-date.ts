import { sql, type SQL } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db/index.js";
import type { ReachMethod } from "./people-client.js";
import { emailPolicyClause, type PoolEmailPolicy } from "./email-policy.js";
import { relationshipClause, type RelationshipScope } from "./reach-sql.js";
import { recentlyEmailedClause, type RecentlyEmailedScope } from "./recently-emailed-sql.js";
import { journalistClause, journalistScopeOf, type JournalistScope } from "./brand-journalists.js";
import { loadProspectFollowupVerdicts, type ProspectFollowupVerdict } from "./prospect-followup.js";
import { toIsoTimestamp } from "./basic-leads.js";

/**
 * EVERY LEAD CARRIES A NEXT FOLLOW-UP DATE (LEAD-FOLLOWUP-DATE-1016, owner 2026-10-16: "Dans lead service, il faut
 * que 100% des leads aient par design une followup date. Default can be now() if any.").
 *
 * Grain: ONE date per (org, brand, lead), table `lead_followup_dates`. The brand follows a person up once, whatever
 * offer or channel last spoke to them: the Unibox row and its relationship tags are at that grain (lead x brand), most
 * people a brand talks with in the Unibox or who signed up have no offer at all, and a per-offer date would let two
 * offers of one brand follow the same person up on the same day.
 *
 * What moves it (one rule each, nothing per channel):
 *   default   every lead of the brand (any `leads_campaigns` row naming the brand) gets `now()` (`ensureLeadFollowupDates`).
 *   send      every send we OBSERVE, on any channel, moves it to send + DEFAULT_GAP_DAYS: email sends and replies
 *             (instantly-service's facts, copied in `outreach_facts`) and every message of ours in the Unibox
 *             (crm-service's `message_out` facts on WhatsApp, LinkedIn, Gmail..., copied in `crm_facts`). Only a send
 *             NEWER than the last one moves it. A date a writer STATED at or after that send is kept (the writer knew
 *             about the send when it chose); a stated date from before it is kept only when it is LATER (a sequence that
 *             stated "J+20" when it queued J+3 and J+10 keeps J+20 when J+3 goes out).
 *   stated    the writer's own date (`stateLeadFollowupDate`, PUT /orgs/leads/{id}/followup-date): exactly what it says,
 *             bounded (not in the past beyond 5 min of skew, not beyond a year), never clamped. Or a STOP in the
 *             person's own words: no date at all, the follow-ups end until a writer states a date again.
 *   served    the "Lead follow-up due" serve hands the person to the follow-up pipe and moves the date to
 *             now + DEFAULT_GAP_DAYS, so a pipe that never writes cannot hand the same person every day.
 *   not_yet / stop_recheck   the serve asked the verdict (prospect-followup.ts, same stops: client, personal and other
 *             relationships, opted out, unsubscribed, bounced, disqualified, booked, positive reply) and it said "not
 *             now" (date = its retry time) or "no" (date = now + STOP_RECHECK_DAYS, re-asked then: a stop is a fact
 *             about today, never a tombstone).
 */

export const DEFAULT_GAP_DAYS = 7;
export const STOP_RECHECK_DAYS = 30;
export const STATED_MAX_DAYS = 366;
export const STATED_SKEW_MS = 5 * 60_000;
export const LEAD_FOLLOWUP_DUE_POPULATION = "lead_followup_due" as const;
export const LEAD_FOLLOWUP_DATES_INTERVAL_MS = 2 * 60_000;
const FIRST_SWEEP_DELAY_MS = 90_000;
const FEED_BATCH = 5_000;
const SWEEP_BUDGET_MS = 60_000;

export type FollowupBasis = "default" | "send" | "stated" | "served" | "not_yet" | "stop_recheck" | "stopped";

export interface ObservedSend {
  orgId: string;
  brandId: string;
  leadId: string;
  sentAt: string;
  channel: string;
}

const gap = sql.raw(`interval '${DEFAULT_GAP_DAYS} days'`);

// ---------------------------------------------------------------------------------------------------------------------
// Default: every lead of every brand carries a date.
// ---------------------------------------------------------------------------------------------------------------------

export interface BrandScope {
  orgId: string;
  brandId: string;
}

/**
 * Give every lead of the brand (every brand, unscoped) that has no date yet the default (now). A lead created after
 * the send feeds were first walked gets its past sends applied right away, so a person the Unibox already talked to
 * is not due today for nothing.
 */
export async function ensureLeadFollowupDates(scope: BrandScope | null = null): Promise<{ inserted: number }> {
  const inserted = (await db.execute(sql`
    INSERT INTO lead_followup_dates (org_id, brand_id, lead_id, next_followup_at, basis, reason)
    SELECT DISTINCT lc.org_id, b, lc.lead_id, now(), 'default', 'Every lead carries a date: nothing sent or stated yet'
    FROM leads_campaigns lc CROSS JOIN LATERAL unnest(lc.brand_ids) AS b
    WHERE lc.org_id IS NOT NULL AND b IS NOT NULL AND b <> ''
      AND (${scope?.orgId ?? null}::text IS NULL OR (lc.org_id = ${scope?.orgId ?? null} AND b = ${scope?.brandId ?? null}))
      AND NOT EXISTS (SELECT 1 FROM lead_followup_dates d WHERE d.org_id = lc.org_id AND d.brand_id = b AND d.lead_id = lc.lead_id)
    ON CONFLICT (org_id, brand_id, lead_id) DO NOTHING
    RETURNING org_id, brand_id, lead_id::text AS lead_id
  `)) as unknown as Array<{ org_id: string; brand_id: string; lead_id: string }>;
  if (inserted.length > 0 && (await feedsStarted())) {
    const byBrand = new Map<string, { orgId: string; brandId: string; leadIds: string[] }>();
    for (const r of inserted) {
      const k = `${r.org_id}|${r.brand_id}`;
      const g = byBrand.get(k) ?? { orgId: r.org_id, brandId: r.brand_id, leadIds: [] };
      g.leadIds.push(r.lead_id);
      byBrand.set(k, g);
    }
    for (const g of byBrand.values()) {
      for (let i = 0; i < g.leadIds.length; i += 500) await applyPastSends(g.orgId, g.brandId, g.leadIds.slice(i, i + 500));
    }
  }
  return { inserted: inserted.length };
}

async function feedsStarted(): Promise<boolean> {
  const rows = (await db.execute(sql`SELECT 1 FROM lead_followup_date_cursors LIMIT 1`)) as unknown as unknown[];
  return rows.length > 0;
}

/** The latest past send to each of these leads at the brand, on both feeds, applied with the send rule. */
async function applyPastSends(orgId: string, brandId: string, leadIds: string[]): Promise<void> {
  const ids = sql.param(leadIds);
  const [email, unibox, uniboxTheirs] = await Promise.all([
    db.execute(sql`
      SELECT cm.lead_id::text AS lead_id, max(o.occurred_at) AS at
      FROM lead_contact_methods cm
      JOIN outreach_facts o ON o.lead_email IN (cm.value, lower(cm.value)) AND o.type IN ('email_sent', 'reply_sent')
        AND o.org_id = ${orgId} AND ${brandId} = ANY(o.brand_ids) AND o.occurred_at IS NOT NULL
      WHERE cm.channel = 'email' AND cm.lead_id = ANY(${ids}::uuid[])
      GROUP BY cm.lead_id
    `) as unknown as Promise<Array<{ lead_id: string; at: Date | string }>>,
    loadUniboxFacts(sql`f.org_id = ${orgId} AND f.brand_id = ${brandId}`).then(matchUniboxSends),
    loadUniboxFacts(sql`f.org_id = ${orgId} AND f.brand_id = ${brandId}`, "theirs").then(matchUniboxSends),
  ]);
  const wanted = new Set(leadIds);
  const sends: ObservedSend[] = [
    ...email.map((r) => ({ orgId, brandId, leadId: r.lead_id, sentAt: toIsoTimestamp(r.at)!, channel: "email" })),
    ...unibox.filter((u) => wanted.has(u.leadId)),
  ];
  await applySends(sends);
  await applyActions(uniboxTheirs.filter((u) => wanted.has(u.leadId)));
}

interface UniboxFact {
  org_id: string;
  brand_id: string;
  at: Date | string;
  channel: string;
  emails: string[];
  phones: string[];
  human_id: string | null;
}

/**
 * The crm facts the filter names, dated: `ours` = our Unibox messages (`message_out`); `theirs` = every fact that is
 * not ours nor bookkeeping (CRM_NOT_THEIR_ACT), so a kind of act crm-service starts stating counts the day it lands.
 */
async function loadUniboxFacts(factFilter: SQL, whose: "ours" | "theirs" = "ours"): Promise<UniboxFact[]> {
  const kind =
    whose === "ours" ? sql`f.type = 'message_out'` : sql`f.type <> ALL(${sql.param([...CRM_NOT_THEIR_ACT])}::text[])`;
  return (await db.execute(sql`
    SELECT f.org_id, f.brand_id, f.occurred_at AS at, COALESCE(NULLIF(f.payload->>'channel', ''), f.source) AS channel,
      f.emails, f.phones, CASE WHEN (f.raw->>'humanId') ~* '^[0-9a-f-]{36}$' THEN f.raw->>'humanId' END AS human_id
    FROM crm_facts f
    WHERE ${kind} AND f.occurred_at IS NOT NULL AND ${factFilter}
  `)) as unknown as UniboxFact[];
}

const digitsOf = (p: string) => p.replace(/\D/g, "");

/**
 * Each Unibox message matched to the leads it names: by the human crm-service states, by any of its email addresses,
 * by any of its phones (digits). Three batched, indexed lookups for the whole batch (as a per-fact join the planner
 * scanned every address: 120 s statement timeout in prod).
 */
async function matchUniboxSends(facts: readonly UniboxFact[]): Promise<ObservedSend[]> {
  if (facts.length === 0) return [];
  const emails = [...new Set(facts.flatMap((f) => f.emails.map((e) => e.trim().toLowerCase())).filter((e) => e.length > 0))];
  const digits = [...new Set(facts.flatMap((f) => f.phones.map(digitsOf)).filter((d) => d.length > 0))];
  const humans = [...new Set(facts.map((f) => f.human_id).filter((h): h is string => !!h))];
  const [byEmail, byPhone, byHuman] = await Promise.all([
    emails.length === 0
      ? Promise.resolve([] as Array<{ k: string; lead_id: string }>)
      : (db.execute(sql`
          SELECT lower(value) AS k, lead_id::text AS lead_id FROM lead_contact_methods
          WHERE channel = 'email' AND lower(value) = ANY(${sql.param(emails)}::text[])
        `) as unknown as Promise<Array<{ k: string; lead_id: string }>>),
    digits.length === 0
      ? Promise.resolve([] as Array<{ k: string; lead_id: string }>)
      : (db.execute(sql`
          SELECT regexp_replace(value, '\\D', '', 'g') AS k, lead_id::text AS lead_id FROM lead_contact_methods
          WHERE channel = 'phone' AND regexp_replace(value, '\\D', '', 'g') = ANY(${sql.param(digits)}::text[])
        `) as unknown as Promise<Array<{ k: string; lead_id: string }>>),
    humans.length === 0
      ? Promise.resolve([] as Array<{ k: string; lead_id: string }>)
      : (db.execute(sql`
          SELECT human_id::text AS k, id::text AS lead_id FROM leads WHERE human_id = ANY(${sql.param(humans)}::uuid[])
        `) as unknown as Promise<Array<{ k: string; lead_id: string }>>),
  ]);
  const index = (rows: Array<{ k: string; lead_id: string }>) => {
    const m = new Map<string, string[]>();
    for (const r of rows) m.set(r.k, [...(m.get(r.k) ?? []), r.lead_id]);
    return m;
  };
  const [e, p, h] = [index(byEmail), index(byPhone), index(byHuman)];
  const out: ObservedSend[] = [];
  for (const f of facts) {
    const leads = new Set<string>([
      ...f.emails.flatMap((x) => e.get(x.trim().toLowerCase()) ?? []),
      ...f.phones.flatMap((x) => p.get(digitsOf(x)) ?? []),
      ...(f.human_id ? (h.get(f.human_id) ?? []) : []),
    ]);
    for (const leadId of leads) out.push({ orgId: f.org_id, brandId: f.brand_id, leadId, sentAt: toIsoTimestamp(f.at)!, channel: f.channel });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sends move the date.
// ---------------------------------------------------------------------------------------------------------------------

/** Keep, per (org, brand, lead), the latest send only: one UPDATE row each. */
function latestPerLead(sends: readonly ObservedSend[]): ObservedSend[] {
  const out = new Map<string, ObservedSend>();
  for (const s of sends) {
    const k = `${s.orgId}|${s.brandId}|${s.leadId}`;
    const prev = out.get(k);
    if (!prev || new Date(s.sentAt).getTime() > new Date(prev.sentAt).getTime()) out.set(k, s);
  }
  return [...out.values()];
}

/**
 * THE SEND RULE, one statement (see the module comment). Only a send newer than the last one recorded moves anything;
 * a stopped person records the send and stays stopped. Rows with no date yet are left to `ensureLeadFollowupDates`.
 */
export async function applySends(sends: readonly ObservedSend[]): Promise<number> {
  const rows = latestPerLead(sends);
  if (rows.length === 0) return 0;
  let moved = 0;
  for (let i = 0; i < rows.length; i += 1_000) {
    const chunk = rows.slice(i, i + 1_000);
    const updated = (await db.execute(sql`
      UPDATE lead_followup_dates d SET
        next_followup_at = CASE
          WHEN d.basis = 'stopped' THEN NULL
          WHEN d.stated_at IS NOT NULL AND d.stated_at >= s.sent_at THEN d.next_followup_at
          WHEN d.basis = 'stated' THEN GREATEST(d.next_followup_at, s.sent_at + ${gap})
          ELSE s.sent_at + ${gap} END,
        basis = CASE
          WHEN d.basis = 'stopped' THEN 'stopped'
          WHEN d.stated_at IS NOT NULL AND d.stated_at >= s.sent_at THEN d.basis
          WHEN d.basis = 'stated' AND d.next_followup_at >= s.sent_at + ${gap} THEN 'stated'
          ELSE 'send' END,
        reason = CASE
          WHEN d.basis = 'stopped' THEN d.reason
          WHEN d.stated_at IS NOT NULL AND d.stated_at >= s.sent_at THEN d.reason
          WHEN d.basis = 'stated' AND d.next_followup_at >= s.sent_at + ${gap} THEN d.reason
          ELSE 'Last ' || s.channel || ${sql.raw(`' send + ${DEFAULT_GAP_DAYS} days'`)} END,
        last_sent_at = s.sent_at,
        last_sent_channel = s.channel,
        sent_count = d.sent_count + 1,
        updated_at = now()
      FROM (
        SELECT * FROM unnest(
          ${sql.param(chunk.map((r) => r.orgId))}::text[],
          ${sql.param(chunk.map((r) => r.brandId))}::text[],
          ${sql.param(chunk.map((r) => r.leadId))}::uuid[],
          ${sql.param(chunk.map((r) => r.sentAt))}::timestamptz[],
          ${sql.param(chunk.map((r) => r.channel))}::text[]
        ) AS x(org_id, brand_id, lead_id, sent_at, channel)
      ) s
      WHERE d.org_id = s.org_id AND d.brand_id = s.brand_id AND d.lead_id = s.lead_id
        AND (d.last_sent_at IS NULL OR s.sent_at > d.last_sent_at)
      RETURNING d.lead_id
    `)) as unknown as unknown[];
    moved += updated.length;
  }
  return moved;
}

/**
 * Did they DO something toward the brand? (owner 2026-10-16: "ce n'est pas qu'on a déjà échangé, mais au moins qu'ils
 * ont fait une action envers nous (website visit, quelque chose)"; "Il ne faut pas un Unibox vide de leurs actions.")
 * Read off the same facts the person's Unibox timeline is built from, never a list of action kinds:
 *   - the labelled timeline (`lead_timeline_facts`, GET /orgs/leads/{id}/timeline): any live fact whose basis is not
 *     `our_email` (our sends and bounces): a reply, a click, a visit, an open, a signup, a form, a meeting, a sale...;
 *   - crm-service's fact copy (the Unibox threads, every channel): any fact that is not ours (`message_out`) nor a
 *     record about them nobody acted (CRM_NOT_THEIR_ACT: corrections, CRM bookkeeping, a no-show), recorded here as
 *     `last_action_at` (it moves no date).
 * A person we only sent to, or never contacted, is cold: "Lead follow-up due" never serves them until they act.
 */
export const CRM_NOT_THEIR_ACT = [
  "message_out",
  "withdrawn",
  "person_merged",
  "person_split",
  "added_to_crm",
  "group_member",
  "deal_status_changed",
  "disqualified",
  "meeting_not_held",
] as const;

export async function applyActions(messages: readonly ObservedSend[]): Promise<void> {
  const rows = latestPerLead(messages);
  for (let i = 0; i < rows.length; i += 1_000) {
    const chunk = rows.slice(i, i + 1_000);
    await db.execute(sql`
      UPDATE lead_followup_dates d SET last_action_at = s.at, updated_at = now()
      FROM (
        SELECT * FROM unnest(
          ${sql.param(chunk.map((r) => r.orgId))}::text[],
          ${sql.param(chunk.map((r) => r.brandId))}::text[],
          ${sql.param(chunk.map((r) => r.leadId))}::uuid[],
          ${sql.param(chunk.map((r) => r.sentAt))}::timestamptz[]
        ) AS x(org_id, brand_id, lead_id, at)
      ) s
      WHERE d.org_id = s.org_id AND d.brand_id = s.brand_id AND d.lead_id = s.lead_id
        AND (d.last_action_at IS NULL OR s.at > d.last_action_at)
    `);
  }
}

/** SQL: the person (row alias `d` of lead_followup_dates) did at least one thing toward the brand (see above). */
export function actedTowardUsSql(d: SQL): SQL {
  return sql`(${d}.last_action_at IS NOT NULL OR EXISTS (
    SELECT 1 FROM lead_timeline_facts t_x
    WHERE t_x.org_id = ${d}.org_id AND t_x.brand_id = ${d}.brand_id AND t_x.lead_id = ${d}.lead_id
      AND t_x.withdrawn_at IS NULL AND t_x.attribution_basis IS DISTINCT FROM 'our_email'))`;
}

async function readCursor(feed: string): Promise<bigint | null> {
  const rows = (await db.execute(sql`SELECT cursor::text AS c FROM lead_followup_date_cursors WHERE feed = ${feed}`)) as unknown as Array<{ c: string }>;
  return rows[0] ? BigInt(rows[0].c) : null;
}

async function writeCursor(feed: string, cursor: bigint): Promise<void> {
  await db.execute(sql`
    INSERT INTO lead_followup_date_cursors (feed, cursor) VALUES (${feed}, ${cursor.toString()}::bigint)
    ON CONFLICT (feed) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = now()
  `);
}

/** One batch of instantly-service's email facts: sends and replies of ours move the date. false = caught up. */
async function stepOutreachFeed(): Promise<boolean> {
  const feed = "outreach_facts";
  const types = ["email_sent", "reply_sent"];
  const from = (await readCursor(feed)) ?? 0n;
  const [edge] = (await db.execute(sql`
    SELECT max(seq)::text AS m FROM (SELECT seq FROM outreach_facts WHERE seq > ${from.toString()}::bigint ORDER BY seq LIMIT ${FEED_BATCH}) b
  `)) as unknown as Array<{ m: string | null }>;
  if (!edge?.m) return false;
  const to = BigInt(edge.m);
  const facts = (await db.execute(sql`
    SELECT o.org_id, b AS brand_id, lower(o.lead_email) AS email, max(o.occurred_at) AS at
    FROM outreach_facts o CROSS JOIN LATERAL unnest(o.brand_ids) AS b
    WHERE o.seq > ${from.toString()}::bigint AND o.seq <= ${to.toString()}::bigint
      AND o.type = ANY(${sql.param(types)}::text[]) AND o.org_id IS NOT NULL AND o.occurred_at IS NOT NULL
    GROUP BY o.org_id, b, lower(o.lead_email)
  `)) as unknown as Array<{ org_id: string; brand_id: string; email: string; at: Date | string }>;
  const emails = [...new Set(facts.map((f) => f.email))];
  const owners =
    emails.length === 0
      ? []
      : ((await db.execute(sql`
          SELECT lower(value) AS email, lead_id::text AS lead_id FROM lead_contact_methods
          WHERE channel = 'email' AND lower(value) = ANY(${sql.param(emails)}::text[])
        `)) as unknown as Array<{ email: string; lead_id: string }>);
  const leadsOf = new Map<string, string[]>();
  for (const o of owners) leadsOf.set(o.email, [...(leadsOf.get(o.email) ?? []), o.lead_id]);
  const observed = facts.flatMap((f) =>
    (leadsOf.get(f.email) ?? []).map((leadId) => ({ orgId: f.org_id, brandId: f.brand_id, leadId, sentAt: toIsoTimestamp(f.at)!, channel: "email" })),
  );
  await applySends(observed);
  await writeCursor(feed, to);
  return true;
}

/**
 * One batch of crm-service's people facts. `out`: every message of ours in the Unibox moves the date. `in`: every act of
 * theirs is recorded (`last_action_at`), on a cursor of its own. false = caught up.
 */
async function stepUniboxFeed(direction: "out" | "in" = "out"): Promise<boolean> {
  const feed = direction === "out" ? "crm_facts" : "crm_facts:theirs";
  const from = (await readCursor(feed)) ?? 0n;
  const [edge] = (await db.execute(sql`
    SELECT max(seq)::text AS m FROM (SELECT seq FROM crm_facts WHERE seq > ${from.toString()}::bigint ORDER BY seq LIMIT ${FEED_BATCH}) b
  `)) as unknown as Array<{ m: string | null }>;
  if (!edge?.m) return false;
  const to = BigInt(edge.m);
  const facts = await loadUniboxFacts(
    sql`f.seq > ${from.toString()}::bigint AND f.seq <= ${to.toString()}::bigint`,
    direction === "out" ? "ours" : "theirs",
  );
  const observed = await matchUniboxSends(facts);
  if (direction === "out") await applySends(observed);
  else await applyActions(observed);
  await writeCursor(feed, to);
  return true;
}

/** Walk both send feeds until caught up or the budget is spent. */
export async function syncSendFeeds(budgetMs = SWEEP_BUDGET_MS): Promise<{ batches: number }> {
  const until = Date.now() + budgetMs;
  let batches = 0;
  const open = { outreach: true, unibox: true, theirs: true };
  while (Object.values(open).some(Boolean) && Date.now() < until) {
    if (open.outreach) open.outreach = await stepOutreachFeed();
    if (open.unibox) open.unibox = await stepUniboxFeed("out");
    if (open.theirs) open.theirs = await stepUniboxFeed("in");
    batches++;
  }
  return { batches };
}

// ---------------------------------------------------------------------------------------------------------------------
// The writer reads and states.
// ---------------------------------------------------------------------------------------------------------------------

export interface FollowupDateRow {
  nextFollowupAt: string | null;
  basis: FollowupBasis;
  reason: string | null;
  statedByCampaignId: string | null;
  statedAt: string | null;
  stoppedAt: string | null;
  lastSentAt: string | null;
  lastSentChannel: string | null;
  sentCount: number;
  lastServedAt: string | null;
  servedCount: number;
  /** Their latest act toward the brand read off the crm facts (null = none there; the timeline may still hold one). */
  lastActionAt: string | null;
  /** Did they ever do something toward the brand? "Lead follow-up due" serves only people who did. */
  actedTowardUs: boolean;
}

type Ts = Date | string | null;
interface RawDateRow {
  next_followup_at: Ts;
  basis: FollowupBasis;
  reason: string | null;
  stated_by_campaign_id: string | null;
  stated_at: Ts;
  stated_run_id: string | null;
  stopped_at: Ts;
  last_sent_at: Ts;
  last_sent_channel: string | null;
  sent_count: number;
  last_served_at: Ts;
  served_count: number;
  last_action_at: Ts;
  acted: boolean;
}
const iso = (v: Ts): string | null => (v === null || v === undefined ? null : toIsoTimestamp(v));

function toRow(r: RawDateRow): FollowupDateRow {
  return {
    nextFollowupAt: iso(r.next_followup_at),
    basis: r.basis,
    reason: r.reason,
    statedByCampaignId: r.stated_by_campaign_id,
    statedAt: iso(r.stated_at),
    stoppedAt: iso(r.stopped_at),
    lastSentAt: iso(r.last_sent_at),
    lastSentChannel: r.last_sent_channel,
    sentCount: Number(r.sent_count),
    lastServedAt: iso(r.last_served_at),
    servedCount: Number(r.served_count),
    lastActionAt: iso(r.last_action_at),
    actedTowardUs: r.acted === true,
  };
}

/** The person's date at the brand; a lead of the brand with none yet gets the default first (100% by design). */
export async function loadFollowupDate(orgId: string, brandId: string, leadId: string): Promise<FollowupDateRow> {
  await db.execute(sql`
    INSERT INTO lead_followup_dates (org_id, brand_id, lead_id, next_followup_at, basis, reason)
    VALUES (${orgId}, ${brandId}, ${leadId}::uuid, now(), 'default', 'Every lead carries a date: nothing sent or stated yet')
    ON CONFLICT (org_id, brand_id, lead_id) DO NOTHING
  `);
  const [r] = (await db.execute(sql`
    SELECT d.*, ${actedTowardUsSql(sql`d`)} AS acted FROM lead_followup_dates d
    WHERE d.org_id = ${orgId} AND d.brand_id = ${brandId} AND d.lead_id = ${leadId}::uuid
  `)) as unknown as RawDateRow[];
  return toRow(r);
}

export interface QueuedForPerson {
  /** Anything of ours waiting to go out to this person at the brand, on any channel. */
  any: boolean;
  /** The email sender still holds a sequence step for them (email-gateway, brand scope). Its send time is the sender's. */
  emailSequence: boolean;
  /** Every follow-up the queue owes them at the brand (`followup_due_at`), with when it is due. */
  followups: Array<{ leadCampaignId: string; campaignId: string; dueAt: string; claimedAt: string | null }>;
  /** They sit in a "Lead follow-up due" source's stock, waiting for the follow-up pipe. */
  inDueStock: boolean;
}

export async function loadQueued(orgId: string, brandId: string, leadId: string, verdict: ProspectFollowupVerdict): Promise<QueuedForPerson> {
  const [followups, stock] = await Promise.all([
    db.execute(sql`
      SELECT id::text AS id, campaign_id, followup_due_at, followup_claimed_at FROM leads_campaigns
      WHERE lead_id = ${leadId}::uuid AND org_id = ${orgId} AND ${brandId} = ANY(brand_ids) AND followup_due_at IS NOT NULL
      ORDER BY followup_due_at ASC
    `) as unknown as Promise<Array<{ id: string; campaign_id: string; followup_due_at: Ts; followup_claimed_at: Ts }>>,
    db.execute(sql`
      SELECT 1 FROM lead_followup_due_serves WHERE org_id = ${orgId} AND brand_id = ${brandId} AND lead_id = ${leadId}::uuid
        AND handed_at IS NULL AND set_aside_at IS NULL LIMIT 1
    `) as unknown as Promise<unknown[]>,
  ]);
  const emailSequence = verdict.reasons.includes("sequence_running");
  const list = followups.map((f) => ({ leadCampaignId: f.id, campaignId: f.campaign_id, dueAt: iso(f.followup_due_at)!, claimedAt: iso(f.followup_claimed_at) }));
  return { any: emailSequence || list.length > 0 || stock.length > 0, emailSequence, followups: list, inDueStock: stock.length > 0 };
}

export type FollowupStatement =
  | { kind: "date"; nextFollowupAt: string; reason: string; sent?: { channel: string; at?: string } }
  | { kind: "sent"; sent: { channel: string; at?: string }; reason?: string }
  | { kind: "stop"; reason: string };

export class FollowupStatementError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** The bounds a stated date must fall in (refused outside, never clamped). */
export function statedDateBounds(now: Date): { earliest: string; latest: string } {
  return {
    earliest: new Date(now.getTime() - STATED_SKEW_MS).toISOString(),
    latest: new Date(now.getTime() + STATED_MAX_DAYS * 86_400_000).toISOString(),
  };
}

/**
 * A writer's statement about one person at the brand. Idempotent on (x-run-id, body): the same run restating the same
 * thing changes nothing (`replayed`). Throws FollowupStatementError on a date outside the bounds.
 */
export async function stateLeadFollowupDate(input: {
  orgId: string;
  brandId: string;
  leadId: string;
  statement: FollowupStatement;
  campaignId: string | null;
  runId: string | null;
  now?: Date;
}): Promise<{ row: FollowupDateRow; replayed: boolean }> {
  const now = input.now ?? new Date();
  const st = input.statement;
  const key = input.runId ? `${input.runId}:${createHash("sha256").update(JSON.stringify(st)).digest("hex").slice(0, 16)}` : null;
  const current = await loadFollowupDate(input.orgId, input.brandId, input.leadId);
  if (key) {
    const [k] = (await db.execute(sql`
      SELECT stated_run_id FROM lead_followup_dates WHERE org_id = ${input.orgId} AND brand_id = ${input.brandId} AND lead_id = ${input.leadId}::uuid
    `)) as unknown as Array<{ stated_run_id: string | null }>;
    if (k?.stated_run_id === key) return { row: current, replayed: true };
  }
  const sentAt = "sent" in st && st.sent ? (st.sent.at ?? now.toISOString()) : null;
  if (sentAt !== null && Number.isNaN(new Date(sentAt).getTime())) throw new FollowupStatementError("invalid_sent_at", `sent.at "${sentAt}" is not a date`);
  if (sentAt !== null && new Date(sentAt).getTime() > now.getTime() + STATED_SKEW_MS) {
    throw new FollowupStatementError("sent_in_future", `sent.at ${sentAt} is in the future: state the send once it went out`);
  }
  const where = sql`org_id = ${input.orgId} AND brand_id = ${input.brandId} AND lead_id = ${input.leadId}::uuid`;

  if (st.kind === "sent") {
    await applySends([{ orgId: input.orgId, brandId: input.brandId, leadId: input.leadId, sentAt: sentAt!, channel: st.sent.channel }]);
    await db.execute(sql`UPDATE lead_followup_dates SET stated_run_id = ${key}, stated_by_campaign_id = COALESCE(${input.campaignId}, stated_by_campaign_id) WHERE ${where}`);
  } else if (st.kind === "stop") {
    await db.execute(sql`
      UPDATE lead_followup_dates SET next_followup_at = NULL, basis = 'stopped', reason = ${st.reason}, stopped_at = ${now.toISOString()}::timestamptz,
        stated_at = ${now.toISOString()}::timestamptz, stated_by_campaign_id = ${input.campaignId}, stated_run_id = ${key}, updated_at = now()
      WHERE ${where}
    `);
  } else {
    const at = new Date(st.nextFollowupAt);
    const bounds = statedDateBounds(now);
    if (Number.isNaN(at.getTime())) throw new FollowupStatementError("invalid_date", `nextFollowupAt "${st.nextFollowupAt}" is not a date`, bounds);
    if (at.toISOString() < bounds.earliest || at.toISOString() > bounds.latest) {
      throw new FollowupStatementError(
        "date_out_of_range",
        `nextFollowupAt ${at.toISOString()} must fall between ${bounds.earliest} and ${bounds.latest}`,
        bounds,
      );
    }
    const sent = sentAt === null ? sql`` : sql`,
        last_sent_at = GREATEST(last_sent_at, ${sentAt}::timestamptz),
        last_sent_channel = CASE WHEN last_sent_at IS NULL OR ${sentAt}::timestamptz >= last_sent_at THEN ${st.sent!.channel} ELSE last_sent_channel END,
        sent_count = sent_count + CASE WHEN last_sent_at IS NULL OR ${sentAt}::timestamptz > last_sent_at THEN 1 ELSE 0 END`;
    await db.execute(sql`
      UPDATE lead_followup_dates SET next_followup_at = ${at.toISOString()}::timestamptz, basis = 'stated', reason = ${st.reason},
        stopped_at = NULL, stated_at = ${now.toISOString()}::timestamptz, stated_by_campaign_id = ${input.campaignId}, stated_run_id = ${key},
        updated_at = now() ${sent}
      WHERE ${where}
    `);
  }
  return { row: await loadFollowupDate(input.orgId, input.brandId, input.leadId), replayed: false };
}

// ---------------------------------------------------------------------------------------------------------------------
// The "Lead follow-up due" serve.
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Who a multichannel follow-up can reach: a lead carrying ANY of the pipe's contact methods (default email or phone; a
 * follow-up writes on whichever the person holds), never a journalist, an email verdict the pipe refuses, a relationship
 * the pipe refuses, or a recently emailed person when the tactic asks it.
 */
export function dueReachClauses(
  leadId: SQL,
  reachableBy: readonly ReachMethod[] | null | undefined,
  acceptedEmails: PoolEmailPolicy | null | undefined,
  relationships: RelationshipScope | null | undefined,
  recentlyEmailed: RecentlyEmailedScope | null | undefined,
  journalists: JournalistScope,
): SQL {
  const methods = reachableBy && reachableBy.length > 0 ? [...new Set(reachableBy)].sort() : (["email", "phone"] as ReachMethod[]);
  return sql.join(
    [
      sql`AND EXISTS (SELECT 1 FROM lead_contact_methods cm_d WHERE cm_d.lead_id = ${leadId} AND cm_d.channel = ANY(${sql.param(methods)}::text[]))`,
      emailPolicyClause(leadId, acceptedEmails),
      relationshipClause(leadId, relationships ?? null),
      recentlyEmailedClause(leadId, recentlyEmailed),
      journalistClause(leadId, journalists),
    ],
    sql` `,
  );
}

/** A due person not owed now: the date moves to when to ask again, with every reason. */
async function postponeDue(
  exec: { execute: typeof db.execute },
  scope: { orgId: string; brandId: string; leadId: string },
  verdict: ProspectFollowupVerdict,
): Promise<void> {
  const basis: FollowupBasis = verdict.kind === "not_yet" ? "not_yet" : "stop_recheck";
  const at =
    verdict.kind === "not_yet" && verdict.retryAfter ? sql`${verdict.retryAfter}::timestamptz` : sql`now() + ${sql.raw(`interval '${STOP_RECHECK_DAYS} days'`)}`;
  const reason = verdict.kind === "not_yet" ? `Not yet: ${verdict.reasons.join(", ")}` : `Not owed a follow-up: ${verdict.reasons.join(", ")} (asked again then)`;
  await exec.execute(sql`
    UPDATE lead_followup_dates SET next_followup_at = ${at}, basis = ${basis}, reason = ${reason}, updated_at = now()
    WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId} AND lead_id = ${scope.leadId}::uuid AND basis <> 'stopped'
  `);
}

export { postponeDue };

/** The person's addresses for the serve: the first registered email and phone (either may be absent, not both). */
export async function contactOf(exec: { execute: typeof db.execute }, leadId: string): Promise<{ email: string | null; phone: string | null }> {
  const rows = (await exec.execute(sql`
    SELECT channel, value FROM lead_contact_methods WHERE lead_id = ${leadId}::uuid AND channel IN ('email', 'phone')
    ORDER BY channel, created_at ASC NULLS LAST, value ASC
  `)) as unknown as Array<{ channel: string; value: string }>;
  return { email: rows.find((r) => r.channel === "email")?.value ?? null, phone: rows.find((r) => r.channel === "phone")?.value ?? null };
}

export interface DueFollowupFind {
  leadId: string;
  leadCampaignId: string;
  email: string | null;
  phone: string | null;
  dueAt: string | null;
}

const DUE_BATCH = 50;
const DUE_MAX_PASSES = 20;

/**
 * The serve of "Lead follow-up due": the brand's lead whose date passed longest ago, whom the verdict says is owed,
 * filed under the SOURCE campaign (`status_reason = 'source_found'`, no audience) with its due-serve row, in ONE
 * transaction. REPEATABLE: a person served before is served again each time their date passes again (their source row
 * is re-opened for the round). A person not owed now has their date pushed out (not yet = its retry time; a stop =
 * asked again in STOP_RECHECK_DAYS) and the next is tried. null = nobody due and owed right now.
 */
export async function claimDueFollowupLead(p: {
  orgId: string;
  brandId: string;
  brandIds: readonly string[];
  sourceCampaignId: string;
  featureSlug: string;
  runId: string | null;
  parentRunId: string | null;
  userId: string | null;
  workflowSlug: string | null;
  goal: string | null;
  activeGoalId: string | null;
  brandProfileId: string | null;
  reachableBy?: readonly ReachMethod[] | null;
  acceptedEmails: PoolEmailPolicy;
  relationships?: RelationshipScope | null;
  recentlyEmailed?: RecentlyEmailedScope | null;
  signal?: AbortSignal;
}): Promise<DueFollowupFind | null> {
  const skipped: string[] = [];
  for (let pass = 0; pass < DUE_MAX_PASSES; pass++) {
    if (p.signal?.aborted) return null;
    const candidates = (await db.execute(sql`
      SELECT d.lead_id::text AS lead_id FROM lead_followup_dates d
      WHERE d.org_id = ${p.orgId} AND d.brand_id = ${p.brandId} AND d.next_followup_at <= now()
        AND ${actedTowardUsSql(sql`d`)}
        AND d.lead_id <> ALL(${sql.param(skipped)}::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM lead_followup_due_serves ds WHERE ds.org_id = d.org_id AND ds.brand_id = d.brand_id AND ds.lead_id = d.lead_id
            AND ds.handed_at IS NULL AND ds.set_aside_at IS NULL)
        ${dueReachClauses(sql`d.lead_id`, p.reachableBy, p.acceptedEmails, p.relationships, p.recentlyEmailed, journalistScopeOf(p.orgId, [p.brandId]))}
      ORDER BY d.next_followup_at ASC, d.lead_id ASC
      LIMIT ${DUE_BATCH}
    `)) as unknown as Array<{ lead_id: string }>;
    if (candidates.length === 0) return null;
    const verdicts = await loadProspectFollowupVerdicts({
      orgId: p.orgId,
      brandId: p.brandId,
      leadIds: candidates.map((c) => c.lead_id),
      context: { userId: p.userId, runId: p.runId },
      contactedRequired: false,
    });
    for (const c of candidates) {
      const v = verdicts.get(c.lead_id);
      if (!v) throw new Error(`[lead-followup-date] no verdict for lead ${c.lead_id} (brand ${p.brandId})`);
      if (!v.owed) {
        await postponeDue(db, { orgId: p.orgId, brandId: p.brandId, leadId: c.lead_id }, v);
        continue;
      }
      const found = await fileDueFind(p, c.lead_id);
      if (found) return found;
      skipped.push(c.lead_id);
    }
  }
  return null;
}

async function fileDueFind(p: Parameters<typeof claimDueFollowupLead>[0], leadId: string): Promise<DueFollowupFind | null> {
  return db.transaction(async (tx) => {
    const [due] = (await tx.execute(sql`
      SELECT next_followup_at FROM lead_followup_dates
      WHERE org_id = ${p.orgId} AND brand_id = ${p.brandId} AND lead_id = ${leadId}::uuid AND next_followup_at <= now()
        AND ${actedTowardUsSql(sql`lead_followup_dates`)}
      FOR UPDATE SKIP LOCKED
    `)) as unknown as Array<{ next_followup_at: Ts }>;
    if (!due) return null;
    const contact = await contactOf(tx, leadId);
    if (!contact.email && !contact.phone) throw new Error(`[lead-followup-date] due lead ${leadId} carries neither an email nor a phone`);
    const brandIds = sql.join(p.brandIds.map((b) => sql`${b}`), sql`, `);
    const details = `Lead follow-up due (LEAD-FOLLOWUP-DATE-1016), due ${iso(due.next_followup_at)}, ${contact.email ? `email=${contact.email}` : `phone=${contact.phone}`}, leadId=${leadId}, campaign=${p.sourceCampaignId}`;
    // A row this source holds from an earlier round (handed or set aside) is re-opened; a find still in its stock is not.
    const [row] = (await tx.execute(sql`
      INSERT INTO leads_campaigns (
        lead_id, campaign_id, org_id, brand_ids, status, status_reason, status_details, served_at,
        parent_run_id, run_id, push_run_id, user_id, workflow_slug, feature_slug, goal, active_goal_id, brand_profile_id
      ) VALUES (
        ${leadId}, ${p.sourceCampaignId}, ${p.orgId}, ARRAY[${brandIds}]::text[], 'served', 'source_found', ${details},
        now(), ${p.parentRunId}, ${p.runId}, ${p.runId}, ${p.userId}, ${p.workflowSlug}, ${p.featureSlug},
        ${p.goal}, ${p.activeGoalId}, ${p.brandProfileId}
      )
      ON CONFLICT (lead_id, campaign_id) DO UPDATE SET
        status = 'served', status_reason = 'source_found', status_details = EXCLUDED.status_details, served_at = now(),
        parent_run_id = EXCLUDED.parent_run_id, run_id = EXCLUDED.run_id, push_run_id = EXCLUDED.push_run_id,
        user_id = EXCLUDED.user_id, workflow_slug = EXCLUDED.workflow_slug, feature_slug = EXCLUDED.feature_slug,
        goal = EXCLUDED.goal, active_goal_id = EXCLUDED.active_goal_id, brand_profile_id = EXCLUDED.brand_profile_id,
        source_handed_at = NULL, source_handed_to_campaign_id = NULL, source_set_aside_at = NULL, source_set_aside_reason = NULL,
        updated_at = now()
      WHERE leads_campaigns.status_reason = 'source_found'
        AND (leads_campaigns.source_handed_at IS NOT NULL OR leads_campaigns.source_set_aside_at IS NOT NULL)
      RETURNING id::text AS id, (xmax <> 0) AS reopened
    `)) as unknown as Array<{ id: string; reopened: boolean }>;
    if (!row) return null;
    if (row.reopened) {
      await tx.execute(sql`
        INSERT INTO lead_campaign_run_repoints (lead_campaign_id, run_id, workflow_slug, repointed_at, cause)
        VALUES (${row.id}::uuid, ${p.runId}, ${p.workflowSlug}, now(), 'followup_due')
      `);
    }
    await tx.execute(sql`
      INSERT INTO lead_followup_due_serves (org_id, brand_id, lead_id, source_campaign_id, lead_campaign_id, due_at)
      VALUES (${p.orgId}, ${p.brandId}, ${leadId}::uuid, ${p.sourceCampaignId}, ${row.id}::uuid, ${iso(due.next_followup_at)}::timestamptz)
    `);
    await tx.execute(sql`
      UPDATE lead_followup_dates SET next_followup_at = now() + ${gap}, basis = 'served',
        reason = ${`Served by Lead follow-up due; nobody sent or stated a date since (asked again in ${DEFAULT_GAP_DAYS} days)`},
        last_served_at = now(), served_count = served_count + 1, updated_at = now()
      WHERE org_id = ${p.orgId} AND brand_id = ${p.brandId} AND lead_id = ${leadId}::uuid
    `);
    return { leadId, leadCampaignId: row.id, email: contact.email, phone: contact.phone, dueAt: iso(due.next_followup_at) };
  });
}

/** The open due serve a stocked source row came from, or null (the row is not a "Lead follow-up due" find). */
export async function openDueServeOfSourceRow(
  exec: { execute: typeof db.execute },
  sourceRowId: string,
): Promise<{ id: string; orgId: string; brandId: string; leadId: string } | null> {
  const rows = (await exec.execute(sql`
    SELECT id::text AS id, org_id, brand_id, lead_id::text AS lead_id FROM lead_followup_due_serves
    WHERE lead_campaign_id = ${sourceRowId}::uuid AND handed_at IS NULL AND set_aside_at IS NULL
    ORDER BY served_at DESC LIMIT 1
  `)) as unknown as Array<{ id: string; org_id: string; brand_id: string; lead_id: string }>;
  const r = rows[0];
  return r ? { id: r.id, orgId: r.org_id, brandId: r.brand_id, leadId: r.lead_id } : null;
}

/** SQL: the stocked source row (alias given) is an open "Lead follow-up due" find. */
export function openDueServeSql(sourceRowId: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM lead_followup_due_serves ds_o WHERE ds_o.lead_campaign_id = ${sourceRowId} AND ds_o.handed_at IS NULL AND ds_o.set_aside_at IS NULL)`;
}

export async function markDueServe(
  exec: { execute: typeof db.execute },
  dueServeId: string,
  outcome: { handedTo: string; handedRowId: string } | { setAsideReason: string },
): Promise<void> {
  if ("handedTo" in outcome) {
    await exec.execute(sql`
      UPDATE lead_followup_due_serves SET handed_at = now(), handed_to_campaign_id = ${outcome.handedTo}, handed_lead_campaign_id = ${outcome.handedRowId}::uuid
      WHERE id = ${dueServeId}::uuid`);
  } else {
    await exec.execute(sql`UPDATE lead_followup_due_serves SET set_aside_at = now(), set_aside_reason = ${outcome.setAsideReason} WHERE id = ${dueServeId}::uuid`);
  }
}

/** Is the person still owed a follow-up by the brand now (any lead, emailed or not)? The verdict the serve reads. */
export async function dueVerdict(
  scope: { orgId: string; brandId: string; leadId: string },
  context: { userId?: string | null; runId?: string | null },
): Promise<ProspectFollowupVerdict> {
  const v = (await loadProspectFollowupVerdicts({ ...scope, leadIds: [scope.leadId], context, contactedRequired: false })).get(scope.leadId);
  if (!v) throw new Error(`[lead-followup-date] no verdict for lead ${scope.leadId} (brand ${scope.brandId})`);
  // No action of theirs toward the brand (only our sends, or nothing) = a follow-up would be cold: not owed until one.
  const [x] = (await db.execute(sql`
    SELECT ${actedTowardUsSql(sql`d`)} AS exchanged FROM lead_followup_dates d
    WHERE d.org_id = ${scope.orgId} AND d.brand_id = ${scope.brandId} AND d.lead_id = ${scope.leadId}::uuid
  `)) as unknown as Array<{ exchanged: boolean }>;
  if (x?.exchanged) return v;
  const reasons = ["no_action_toward_us" as const, ...v.reasons];
  return { ...v, owed: false, kind: "stop", retryAfter: null, reason: "no_action_toward_us", reasons };
}

// ---------------------------------------------------------------------------------------------------------------------
// Background thread.
// ---------------------------------------------------------------------------------------------------------------------

let sweeping = false;

export function startLeadFollowupDatesWorker(beforeDates: () => Promise<unknown>): void {
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      await beforeDates().catch((err: unknown) => console.error("[lead-service] lead follow-up dates: intake before dating failed:", err));
      const ensured = await ensureLeadFollowupDates();
      const synced = await syncSendFeeds();
      if (ensured.inserted > 0 || synced.batches > 1) {
        console.log(`[lead-service] lead follow-up dates: dated=${ensured.inserted} sendBatches=${synced.batches}`);
      }
    } catch (err) {
      console.error("[lead-service] lead follow-up dates sweep failed:", err);
    } finally {
      sweeping = false;
    }
  };
  setTimeout(() => void tick(), FIRST_SWEEP_DELAY_MS).unref();
  setInterval(() => void tick(), LEAD_FOLLOWUP_DATES_INTERVAL_MS).unref();
}
