/**
 * ONE lead's Unibox state, for an agent (AGENT-READS-LEAD-1105, owner 2026-11-05: "pourquoi ne pas donner aussi le
 * statut de l'Unibox avec ce lead ? tous les champs dont last action, lifecycle, etc."). Sophie told a client three
 * times that Edmund Bartlett "replied with interest and nobody answered him": she read the conversation, it was
 * truncated to its oldest messages, and our three answers never reached her. This read serves what the Unibox
 * already holds for the person, small and FIXED in size whatever the thread's length: the row's six dimensions, who
 * acted last and when, whether a word of theirs waits on us, the next follow-up date and how many messages went
 * each way. Nothing is re-derived: the row is `unibox_rows` (unibox-model.ts), the date is `lead_followup_dates`
 * (lead-follow-up-date.ts), the counts read the same copies the row is built from (outreach facts current per
 * subject, crm facts on the relation's own contact points).
 *
 *   GET /orgs/leads/unibox-state?(leadId=<uuid>|email=<address>)[&brandId=<uuid>]
 *
 * Without `brandId`, the org's rows holding the lead/address answer when they are all one brand; several brands =
 * `AmbiguousBrandError` (the caller names one). Gateway: `/v1/leads/unibox-state` (the `/v1/leads/:id` passthrough).
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { addressSpellings, loadLifecycleCatalogue, toRow, type UniboxRow } from "./unibox-model.js";

type Ts = Date | string;
const iso = (v: Ts | null | undefined): string | null => (v === null || v === undefined ? null : toIsoTimestamp(v));

export class AmbiguousBrandError extends Error {
  constructor(readonly brandIds: string[]) {
    super(`this lead is in the Unibox of several brands (${brandIds.join(", ")}); name one with brandId`);
  }
}

export interface UniboxMessageCounts {
  /** Every message we sent them: sequence emails + answers in the email thread + messages on other channels. */
  ours: number;
  /** Every message they sent us: email replies (auto-replies included) + messages on other channels. */
  theirs: number;
  sequenceEmails: number;
  emailAnswers: number;
  emailReplies: number;
  otherChannelsOurs: number;
  otherChannelsTheirs: number;
}

export interface UniboxNextFollowup {
  /** null only when follow-ups are stopped for this person (`basis: "stopped"`). */
  at: string | null;
  basis: string;
  reason: string | null;
}

export interface UniboxLeadState {
  brandId: string;
  /** The lead named (by id), else the row's first lead. */
  leadId: string | null;
  lead: UniboxRow;
  /** Who acted LAST in the conversation and when: `ours` = a message of ours, `theirs` = a word or act of theirs. */
  lastAction: { side: "ours" | "theirs"; at: string } | null;
  /** A word of theirs is newer than our latest message and the conversation is open (= `conversation: waiting_on_us`). */
  waitingOnUs: boolean;
  nextFollowup: UniboxNextFollowup | null;
  nextFollowupReason: "no_date_yet" | null;
  messages: UniboxMessageCounts;
  /** When the relationship sweep last wrote this row (the state is as of then; the fast lane rewrites it within a minute of a reply). */
  builtAt: string | null;
}

/** Pure: who acted last. A tie reads as ours (an answer sent at the second their word arrived answered it). */
export function lastActionOf(lastOursAt: string | null, lastTheirsAt: string | null): UniboxLeadState["lastAction"] {
  if (lastOursAt === null && lastTheirsAt === null) return null;
  if (lastTheirsAt === null) return { side: "ours", at: lastOursAt! };
  if (lastOursAt === null) return { side: "theirs", at: lastTheirsAt };
  return Date.parse(lastTheirsAt) > Date.parse(lastOursAt) ? { side: "theirs", at: lastTheirsAt } : { side: "ours", at: lastOursAt };
}

/** Pure: the per-kind counts folded into ours / theirs. */
export function messageCountsOf(c: Omit<UniboxMessageCounts, "ours" | "theirs">): UniboxMessageCounts {
  return {
    ours: c.sequenceEmails + c.emailAnswers + c.otherChannelsOurs,
    theirs: c.emailReplies + c.otherChannelsTheirs,
    ...c,
  };
}

/** Pure: the person's next follow-up date at the brand, the earliest over the row's leads (one lead almost always). */
export function nextFollowupOf(rows: ReadonlyArray<{ next_followup_at: Ts | null; basis: string; reason: string | null }>): UniboxNextFollowup | null {
  if (rows.length === 0) return null;
  const dated = rows.filter((r) => r.next_followup_at !== null).sort((a, b) => Date.parse(iso(a.next_followup_at)!) - Date.parse(iso(b.next_followup_at)!));
  const pick = dated[0] ?? rows[0];
  return { at: iso(pick.next_followup_at), basis: pick.basis, reason: pick.reason ?? null };
}

export async function readUniboxLeadState(
  orgId: string,
  q: { brandId: string | null; leadId: string | null; email: string | null },
): Promise<UniboxLeadState | null> {
  const catalogue = await loadLifecycleCatalogue();
  const byBrand = q.brandId === null ? sql`` : sql`AND u.brand_id = ${q.brandId}`;
  const byWho =
    q.leadId !== null
      ? sql`AND ${q.leadId}::uuid = ANY(u.lead_ids)`
      : sql`AND EXISTS (SELECT 1 FROM unnest(u.emails) e WHERE lower(e) = ${q.email!.toLowerCase()})`;
  const rows = (await db.execute(sql`
    SELECT u.*, (SELECT s.contact_points FROM relationship_subjects s
      WHERE s.org_id = u.org_id AND s.brand_id = u.brand_id AND s.human_id = u.human_id AND s.company_key = u.company_key) AS contact_points
    FROM unibox_rows u WHERE u.org_id = ${orgId} ${byBrand} ${byWho}
    ORDER BY u.last_activity_at DESC, u.human_id, u.company_key
  `)) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return null;
  const brands = Array.from(new Set(rows.map((r) => String(r.brand_id))));
  if (brands.length > 1) throw new AmbiguousBrandError(brands.sort());
  const raw = rows[0];
  const brandId = brands[0];
  const lead = toRow(raw, catalogue.ladder);
  const points = (raw.contact_points as string[] | null) ?? [];

  const [followups, outreach, crm] = await Promise.all([
    lead.leadIds.length === 0
      ? Promise.resolve([] as Array<{ next_followup_at: Ts | null; basis: string; reason: string | null }>)
      : (db.execute(sql`
          SELECT next_followup_at, basis, reason FROM lead_followup_dates
          WHERE org_id = ${orgId} AND brand_id = ${brandId} AND lead_id = ANY(${sql.param(lead.leadIds)}::uuid[])
        `) as unknown as Promise<Array<{ next_followup_at: Ts | null; basis: string; reason: string | null }>>),
    // The outreach copy, CURRENT fact per subject (a withdrawn subject is absent), the row's own addresses at the brand:
    // the same read the row's "our answers" come from.
    lead.emails.length === 0
      ? Promise.resolve([] as Array<{ type: string; n: number }>)
      : (db.execute(sql`
          SELECT c.type, count(*)::int AS n
          FROM (
            SELECT DISTINCT ON (o.subject_key) o.type, o.brand_ids
            FROM outreach_facts o
            WHERE o.org_id = ${orgId} AND o.lead_email = ANY(${sql.param(addressSpellings(lead.emails))}::text[])
            ORDER BY o.subject_key, o.seq DESC
          ) c
          WHERE ${brandId} = ANY(c.brand_ids) AND c.type IN ('email_sent', 'reply_sent', 'reply')
          GROUP BY 1
        `) as unknown as Promise<Array<{ type: string; n: number }>>),
    // Messages on the relation's own contact points (WhatsApp, LinkedIn, the brand's mailbox...), withdrawn ones out.
    points.length === 0
      ? Promise.resolve([] as Array<{ type: string; n: number }>)
      : (db.execute(sql`
          SELECT f.type, count(*)::int AS n FROM crm_facts f
          WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId} AND f.contact_point = ANY(${sql.param(points)}::text[])
            AND f.type IN ('message_in', 'message_out')
            AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = f.fact_id)
          GROUP BY 1
        `) as unknown as Promise<Array<{ type: string; n: number }>>),
  ]);
  const count = (rs: Array<{ type: string; n: number }>, t: string) => rs.find((r) => r.type === t)?.n ?? 0;
  const nextFollowup = nextFollowupOf(followups);
  return {
    brandId,
    leadId: q.leadId ?? lead.leadIds[0] ?? null,
    lead,
    lastAction: lastActionOf(lead.lastOursAt, lead.lastTheirsAt),
    waitingOnUs: lead.conversation === "waiting_on_us",
    nextFollowup,
    nextFollowupReason: nextFollowup === null ? "no_date_yet" : null,
    messages: messageCountsOf({
      sequenceEmails: count(outreach, "email_sent"),
      emailAnswers: count(outreach, "reply_sent"),
      emailReplies: count(outreach, "reply"),
      otherChannelsOurs: count(crm, "message_out"),
      otherChannelsTheirs: count(crm, "message_in"),
    }),
    builtAt: iso(raw.updated_at as Ts | null),
  };
}
