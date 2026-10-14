/**
 * WHO BOOKED a meeting: our AI Meeting Booking answering a positive reply, or the client's own team
 * (owner 2026-10-13, MEETING-ATTRIBUTION-1013). features-service serves the "AI vs your team" gain
 * (Positive reply -> Meeting booked rate per side, with the people each rate is based on) off this
 * read, and must never compute it from a guess ("which campaign was live on the brand that day").
 *
 * A meeting is a live `meeting_booked` / `meeting_attended` row of `conversion_events` (calendar
 * tracker, CRM, a person's statement: every path that records one). Nothing is stored here: the
 * answer is DERIVED ON READ from positive facts about the same person at the same brand, so every
 * meeting already recorded is answered the moment its facts exist, and no meeting row is rewritten.
 *
 *   person          the lead the row is attributed to (`matched_lead_id`, else the lifecycle row a
 *                   person named). An unmatched or held (needs_review) row has no person: UNKNOWN.
 *   positive reply  the person's replies the provider judged positive (`lead_timeline_facts`, source
 *                   `reply`, the verdict's own `classification`), and the positive reply the
 *                   customer's CRM evidences (`conversion_events` `positive_reply`, source `crm`).
 *   an answer       an act of ours on that person, each a recorded fact naming who did it:
 *                     - AI: a follow-up ledger `acted` row (`followup_actions`), naming the ACTING
 *                       campaign (campaign-service says its channel and leg); an outreach
 *                       `reply_sent` the sender states `sentBy: automation` is the same act seen
 *                       from the mailbox: it takes the campaign of the ledger act it records
 *                       (same person, within `SAME_ACT_WINDOW_MS`), else, for a queued send, the
 *                       ONE campaign every earlier AI act on that person names; else unknown;
 *                     - a PERSON (the client's team): an outreach `reply_sent` stated
 *                       `sentBy: human` (Unibox, replies route, staff client), an email from their
 *                       own Gmail Jev judged an answer (`outside_answer_judgments`), or an
 *                       "answered outside" statement. Its campaign is the brand's Your Team Meeting
 *                       Booking campaign of that offer when one exists (campaign IDENTITY: org,
 *                       brand, offer, leg, channel), else null: the team answered either way.
 *
 * The rule (one, for every meeting and every person):
 *   - a meeting is booked by the LATEST answer of ours dated at or after the person's first positive
 *     reply and at or before the meeting; its positive reply is the latest one at or before it;
 *   - the person's HANDLER (the population a rate divides by) is the same answer for a person who
 *     booked, else the latest answer to date. One handler per person: the sides PARTITION the people
 *     who replied positively (+ `unhandled`: nobody answered them), checked on every read.
 * Every meeting the rule cannot answer is `unknown` with its reason, never given to a side:
 * `person_unknown`, `match_needs_review`, `undated`, `no_positive_reply_before`,
 * `no_answer_before_meeting`, `ai_campaign_unknown`. An AI act of ANOTHER leg (AI Instant Call, a
 * WhatsApp responder) is known and reported as `other`, never folded into AI Meeting Booking.
 *
 * WhatsApp/LinkedIn messages of ours (crm fact copy) are not answers here: the copy does not say
 * whether a person or our AI wrote them, and a side is never guessed.
 */
import { sql } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { CAMPAIGN_SERVICE_API_KEY, CAMPAIGN_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { CRM_POSITIVE_REPLY_STEP } from "./crm-evidence.js";
import type { MeetingArm, MeetingUnknownReason } from "./meeting-attribution-vocab.js";

export type { MeetingArm, MeetingUnknownReason };

/** The leg the comparison is about: Positive reply -> Meeting booked. */
export const MEETING_LEG_KEY = "conversation_to_meeting_booked";
export const AI_MEETING_BOOKING_SLUG = "ai-meeting-booking";
export const YOUR_TEAM_MEETING_BOOKING_SLUG = "your-team-meeting-booking";
/** An automation `reply_sent` and the ledger act it records are written seconds apart. */
export const SAME_ACT_WINDOW_MS = 10 * 60_000;


export class MeetingAttributionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeetingAttributionUnavailableError";
  }
}

// ---------------------------------------------------------------------------------------------
// Pure rule
// ---------------------------------------------------------------------------------------------

export interface MeetingFact {
  conversionEventId: string;
  orgId: string;
  brandId: string;
  event: string;
  source: string;
  email: string | null;
  occurredAt: string | null;
  /** null = the row names no person (unmatched / held). */
  leadId: string | null;
  attributionStatus: string;
}

export interface PositiveReplyFact {
  ref: string;
  orgId: string;
  brandId: string;
  leadId: string;
  offerId: string | null;
  campaignId: string | null;
  occurredAt: string;
}

export type AnswerKind = "ai" | "person";

export interface AnswerFact {
  ref: string;
  kind: AnswerKind;
  orgId: string;
  brandIds: string[];
  leadId: string;
  occurredAt: string;
  /** How it was recorded: `followup_ledger`, `reply_sent`, `gmail_answer`, `answered_outside`. */
  via: string;
  /** AI: the acting campaign, null when nothing names it. Person: null (resolved per offer). */
  campaignId: string | null;
}

export interface CampaignCard {
  id: string;
  orgId: string;
  brandIds: string[];
  offerId: string | null;
  legKey: string | null;
  featureSlug: string | null;
  status: string | null;
}

export interface BookedBy {
  kind: AnswerKind;
  campaignId: string | null;
  featureSlug: string | null;
  legKey: string | null;
  answerRef: string;
  answerVia: string;
  answeredAt: string;
}

export interface AttributedMeeting {
  conversionEventId: string;
  orgId: string;
  brandId: string;
  event: string;
  source: string;
  email: string | null;
  occurredAt: string | null;
  leadId: string | null;
  positiveReply: { ref: string; at: string } | null;
  bookedBy: BookedBy | null;
  arm: MeetingArm;
  unknownReason: MeetingUnknownReason | null;
}

export interface ArmCounts {
  /** People who replied positively whose handler is on this side. */
  handled: number;
  /** Of them, people whose first meeting after the positive reply this side booked. */
  booked: number;
  /** booked / handled, null when nobody was handled. */
  rate: number | null;
}

export interface OtherHandlerCounts extends ArmCounts {
  featureSlug: string | null;
  legKey: string | null;
}

export interface AttributionSummary {
  /** People who replied positively (per brand), first positive reply in the window. */
  positiveReplyPeople: number;
  arms: {
    aiMeetingBooking: ArmCounts;
    yourTeamMeetingBooking: ArmCounts;
    /** An AI answer whose campaign nothing names. */
    unknown: ArmCounts;
    /** AI acts of another leg (AI Instant Call, a WhatsApp responder...). */
    other: OtherHandlerCounts[];
  };
  /** Replied positively, no answer of ours (yet): in no side's population. */
  unhandled: { people: number; booked: number };
  /** Meetings in the window by side (`unknown` carries its reasons). */
  meetings: {
    total: number;
    aiMeetingBooking: number;
    yourTeamMeetingBooking: number;
    other: number;
    unknown: number;
    unknownReasons: Partial<Record<MeetingUnknownReason, number>>;
  };
}

export interface MeetingAttributionResult {
  summary: AttributionSummary;
  byBrand: Array<{ orgId: string; brandId: string } & AttributionSummary>;
  attributedMeetings: AttributedMeeting[];
}

const ms = (iso: string) => Date.parse(iso);

function emptyArm(): ArmCounts {
  return { handled: 0, booked: 0, rate: null };
}

function emptySummary(): AttributionSummary {
  return {
    positiveReplyPeople: 0,
    arms: { aiMeetingBooking: emptyArm(), yourTeamMeetingBooking: emptyArm(), unknown: emptyArm(), other: [] },
    unhandled: { people: 0, booked: 0 },
    meetings: { total: 0, aiMeetingBooking: 0, yourTeamMeetingBooking: 0, other: 0, unknown: 0, unknownReasons: {} },
  };
}

/** The brand's Your Team Meeting Booking campaign of an offer: ongoing first, else the newest. */
export function yourTeamCampaign(
  campaigns: readonly CampaignCard[],
  orgId: string,
  brandId: string,
  offerId: string | null,
): CampaignCard | null {
  const matches = campaigns.filter(
    (c) =>
      c.orgId === orgId &&
      c.brandIds.includes(brandId) &&
      c.featureSlug === YOUR_TEAM_MEETING_BOOKING_SLUG &&
      c.legKey === MEETING_LEG_KEY &&
      (offerId === null || c.offerId === offerId),
  );
  return matches.find((c) => c.status === "ongoing") ?? matches[0] ?? null;
}

function armOf(by: BookedBy): MeetingArm {
  if (by.kind === "person") return "yourTeamMeetingBooking";
  if (by.campaignId === null) return "unknown";
  if (by.featureSlug === AI_MEETING_BOOKING_SLUG && by.legKey === MEETING_LEG_KEY) return "aiMeetingBooking";
  return "other";
}

/**
 * Pure: attribute every meeting and partition every person who replied positively.
 * `since` (optional) keeps people whose FIRST positive reply is at or after it, and meetings at or
 * after it; `nowIso` anchors the handler of a person who has not booked.
 */
export function attributeMeetings(input: {
  meetings: readonly MeetingFact[];
  positiveReplies: readonly PositiveReplyFact[];
  answers: readonly AnswerFact[];
  campaigns: readonly CampaignCard[];
  since?: string | null;
}): MeetingAttributionResult {
  const sinceMs = input.since ? ms(input.since) : Number.NEGATIVE_INFINITY;
  const campaignById = new Map(input.campaigns.map((c) => [c.id, c]));
  const key = (orgId: string, brandId: string, leadId: string) => `${orgId}|${brandId}|${leadId}`;

  const repliesByPerson = new Map<string, PositiveReplyFact[]>();
  for (const r of input.positiveReplies) {
    const k = key(r.orgId, r.brandId, r.leadId);
    const list = repliesByPerson.get(k) ?? [];
    list.push(r);
    repliesByPerson.set(k, list);
  }
  for (const list of repliesByPerson.values()) list.sort((a, b) => ms(a.occurredAt) - ms(b.occurredAt));

  // An automation reply_sent is the mailbox's copy of a ledger act: it takes that act's campaign.
  const ledger = input.answers.filter((a) => a.via === "followup_ledger");
  const resolvedAnswers: AnswerFact[] = input.answers.map((a) => {
    if (a.kind !== "ai" || a.campaignId !== null) return a;
    const twin = ledger
      .filter(
        (l) =>
          l.orgId === a.orgId &&
          l.leadId === a.leadId &&
          l.campaignId !== null &&
          l.brandIds.some((b) => a.brandIds.includes(b)) &&
          Math.abs(ms(l.occurredAt) - ms(a.occurredAt)) <= SAME_ACT_WINDOW_MS,
      )
      .sort((x, y) => Math.abs(ms(x.occurredAt) - ms(a.occurredAt)) - Math.abs(ms(y.occurredAt) - ms(a.occurredAt)))[0];
    if (twin) return { ...a, campaignId: twin.campaignId };
    // A queued send goes out hours after the act that wrote it: the campaign is still named when
    // every AI act on that person before the send names the same one (several = unknown).
    const earlier = new Set(
      ledger
        .filter(
          (l) =>
            l.orgId === a.orgId &&
            l.leadId === a.leadId &&
            l.campaignId !== null &&
            l.brandIds.some((b) => a.brandIds.includes(b)) &&
            ms(l.occurredAt) <= ms(a.occurredAt),
        )
        .map((l) => l.campaignId as string),
    );
    return earlier.size === 1 ? { ...a, campaignId: [...earlier][0] } : a;
  });

  const answersByPerson = new Map<string, AnswerFact[]>();
  for (const a of resolvedAnswers) {
    for (const brandId of new Set(a.brandIds)) {
      const k = key(a.orgId, brandId, a.leadId);
      const list = answersByPerson.get(k) ?? [];
      list.push(a);
      answersByPerson.set(k, list);
    }
  }
  for (const list of answersByPerson.values()) list.sort((a, b) => ms(a.occurredAt) - ms(b.occurredAt));

  const bookedBy = (answer: AnswerFact, orgId: string, brandId: string, offerId: string | null): BookedBy => {
    const campaign =
      answer.kind === "person"
        ? yourTeamCampaign(input.campaigns, orgId, brandId, offerId)
        : answer.campaignId !== null
          ? campaignById.get(answer.campaignId) ?? null
          : null;
    return {
      kind: answer.kind,
      campaignId: answer.kind === "person" ? campaign?.id ?? null : answer.campaignId,
      featureSlug: answer.kind === "person" ? YOUR_TEAM_MEETING_BOOKING_SLUG : campaign?.featureSlug ?? null,
      legKey: answer.kind === "person" ? MEETING_LEG_KEY : campaign?.legKey ?? null,
      answerRef: answer.ref,
      answerVia: answer.via,
      answeredAt: answer.occurredAt,
    };
  };

  /** Latest answer in [from, to] for the person. */
  const latestAnswer = (k: string, fromMs: number, toMs: number): AnswerFact | null => {
    const list = answersByPerson.get(k) ?? [];
    let found: AnswerFact | null = null;
    for (const a of list) {
      const t = ms(a.occurredAt);
      if (t >= fromMs && t <= toMs) found = a;
    }
    return found;
  };

  // --- per meeting ---
  const attributedMeetings: AttributedMeeting[] = [];
  for (const m of input.meetings) {
    if (m.occurredAt !== null && ms(m.occurredAt) < sinceMs) continue;
    const base = {
      conversionEventId: m.conversionEventId,
      orgId: m.orgId,
      brandId: m.brandId,
      event: m.event,
      source: m.source,
      email: m.email,
      occurredAt: m.occurredAt,
      leadId: m.leadId,
    };
    const unknown = (reason: MeetingUnknownReason, positiveReply: AttributedMeeting["positiveReply"] = null, by: BookedBy | null = null): AttributedMeeting => ({
      ...base,
      positiveReply,
      bookedBy: by,
      arm: "unknown",
      unknownReason: reason,
    });
    if (m.leadId === null) {
      attributedMeetings.push(unknown(m.attributionStatus === "needs_review" ? "match_needs_review" : "person_unknown"));
      continue;
    }
    if (m.occurredAt === null) {
      attributedMeetings.push(unknown("undated"));
      continue;
    }
    const k = key(m.orgId, m.brandId, m.leadId);
    const at = ms(m.occurredAt);
    const replies = (repliesByPerson.get(k) ?? []).filter((r) => ms(r.occurredAt) <= at);
    if (replies.length === 0) {
      attributedMeetings.push(unknown("no_positive_reply_before"));
      continue;
    }
    const lastReply = replies[replies.length - 1];
    const positiveReply = { ref: lastReply.ref, at: lastReply.occurredAt };
    const answer = latestAnswer(k, ms(replies[0].occurredAt), at);
    if (answer === null) {
      attributedMeetings.push(unknown("no_answer_before_meeting", positiveReply));
      continue;
    }
    const by = bookedBy(answer, m.orgId, m.brandId, lastReply.offerId);
    const arm = armOf(by);
    attributedMeetings.push(
      arm === "unknown"
        ? unknown("ai_campaign_unknown", positiveReply, by)
        : { ...base, positiveReply, bookedBy: by, arm, unknownReason: null },
    );
  }
  attributedMeetings.sort((a, b) => (a.occurredAt ?? "").localeCompare(b.occurredAt ?? "") || a.conversionEventId.localeCompare(b.conversionEventId));

  // --- per person (the populations) ---
  const meetingsByPerson = new Map<string, AttributedMeeting[]>();
  for (const m of attributedMeetings) {
    if (m.leadId === null || m.occurredAt === null) continue;
    const k = key(m.orgId, m.brandId, m.leadId);
    const list = meetingsByPerson.get(k) ?? [];
    list.push(m);
    meetingsByPerson.set(k, list);
  }

  const summaries = new Map<string, { orgId: string; brandId: string; s: AttributionSummary }>();
  const summaryOf = (orgId: string, brandId: string) => {
    const k = `${orgId}|${brandId}`;
    let entry = summaries.get(k);
    if (!entry) {
      entry = { orgId, brandId, s: emptySummary() };
      summaries.set(k, entry);
    }
    return entry.s;
  };
  const otherOf = (s: AttributionSummary, by: BookedBy) => {
    let o = s.arms.other.find((x) => x.featureSlug === by.featureSlug && x.legKey === by.legKey);
    if (!o) {
      o = { featureSlug: by.featureSlug, legKey: by.legKey, ...emptyArm() };
      s.arms.other.push(o);
    }
    return o;
  };

  for (const [k, replies] of repliesByPerson) {
    const first = replies[0];
    if (ms(first.occurredAt) < sinceMs) continue;
    const s = summaryOf(first.orgId, first.brandId);
    s.positiveReplyPeople += 1;
    const firstMeeting = (meetingsByPerson.get(k) ?? [])
      .filter((m) => ms(m.occurredAt as string) >= ms(first.occurredAt))
      .sort((a, b) => ms(a.occurredAt as string) - ms(b.occurredAt as string))[0];

    let by: BookedBy | null;
    let booked: boolean;
    if (firstMeeting) {
      by = firstMeeting.bookedBy;
      booked = true;
    } else {
      const answer = latestAnswer(k, ms(first.occurredAt), Number.POSITIVE_INFINITY);
      by = answer ? bookedBy(answer, first.orgId, first.brandId, replies[replies.length - 1].offerId) : null;
      booked = false;
    }
    if (by === null) {
      s.unhandled.people += 1;
      if (booked) s.unhandled.booked += 1;
      continue;
    }
    const arm = armOf(by);
    const counts = arm === "other" ? otherOf(s, by) : s.arms[arm];
    counts.handled += 1;
    if (booked) counts.booked += 1;
  }

  for (const m of attributedMeetings) {
    const s = summaryOf(m.orgId, m.brandId);
    s.meetings.total += 1;
    s.meetings[m.arm] += 1;
    if (m.unknownReason) s.meetings.unknownReasons[m.unknownReason] = (s.meetings.unknownReasons[m.unknownReason] ?? 0) + 1;
  }

  const finish = (s: AttributionSummary) => {
    for (const c of [s.arms.aiMeetingBooking, s.arms.yourTeamMeetingBooking, s.arms.unknown, ...s.arms.other]) {
      c.rate = c.handled > 0 ? c.booked / c.handled : null;
    }
    s.arms.other.sort((a, b) => `${a.featureSlug}|${a.legKey}`.localeCompare(`${b.featureSlug}|${b.legKey}`));
    const handled =
      s.arms.aiMeetingBooking.handled +
      s.arms.yourTeamMeetingBooking.handled +
      s.arms.unknown.handled +
      s.arms.other.reduce((n, o) => n + o.handled, 0);
    if (handled + s.unhandled.people !== s.positiveReplyPeople) {
      throw new Error(`[meeting-attribution] sides are not a partition: ${JSON.stringify(s)}`);
    }
    const sides = s.meetings.aiMeetingBooking + s.meetings.yourTeamMeetingBooking + s.meetings.other + s.meetings.unknown;
    if (sides !== s.meetings.total) throw new Error(`[meeting-attribution] meetings are not a partition: ${JSON.stringify(s.meetings)}`);
    return s;
  };

  const total = emptySummary();
  const byBrand = [...summaries.values()]
    .sort((a, b) => a.orgId.localeCompare(b.orgId) || a.brandId.localeCompare(b.brandId))
    .map(({ orgId, brandId, s }) => {
      finish(s);
      total.positiveReplyPeople += s.positiveReplyPeople;
      for (const arm of ["aiMeetingBooking", "yourTeamMeetingBooking", "unknown"] as const) {
        total.arms[arm].handled += s.arms[arm].handled;
        total.arms[arm].booked += s.arms[arm].booked;
      }
      for (const o of s.arms.other) {
        const t = otherOf(total, { featureSlug: o.featureSlug, legKey: o.legKey } as BookedBy);
        t.handled += o.handled;
        t.booked += o.booked;
      }
      total.unhandled.people += s.unhandled.people;
      total.unhandled.booked += s.unhandled.booked;
      for (const f of ["total", "aiMeetingBooking", "yourTeamMeetingBooking", "other", "unknown"] as const) {
        total.meetings[f] += s.meetings[f];
      }
      for (const [r, n] of Object.entries(s.meetings.unknownReasons)) {
        const reason = r as MeetingUnknownReason;
        total.meetings.unknownReasons[reason] = (total.meetings.unknownReasons[reason] ?? 0) + (n ?? 0);
      }
      return { orgId, brandId, ...s };
    });

  return { summary: finish(total), byBrand, attributedMeetings };
}

// ---------------------------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------------------------

type Ts = Date | string | null;

function iso(value: Ts): string | null {
  return value === null || value === undefined ? null : toIsoTimestamp(value);
}

async function readMeetings(brandId: string | null): Promise<MeetingFact[]> {
  const rows = (await sql`
    SELECT ce.id::text AS id, ce.org_id, ce.brand_id, ce.event, ce.source, ce.email, ce.received_at,
           ce.attribution_status,
           CASE WHEN ce.attribution_status = 'attributed'
                THEN COALESCE(ce.matched_lead_id, lc.lead_id)::text END AS lead_id
    FROM conversion_events ce
    LEFT JOIN leads_campaigns lc ON lc.id = ce.lead_campaign_id
    WHERE ce.event IN ('meeting_booked', 'meeting_attended')
      AND ce.withdrawn_at IS NULL
      ${brandId ? sql`AND ce.brand_id = ${brandId}` : sql``}
  `) as unknown as Array<{
    id: string;
    org_id: string;
    brand_id: string;
    event: string;
    source: string;
    email: string | null;
    received_at: Ts;
    attribution_status: string;
    lead_id: string | null;
  }>;
  return rows.map((r) => ({
    conversionEventId: r.id,
    orgId: r.org_id,
    brandId: r.brand_id,
    event: r.event,
    source: r.source,
    email: r.email,
    occurredAt: iso(r.received_at),
    leadId: r.lead_id,
    attributionStatus: r.attribution_status,
  }));
}

async function readPositiveReplies(brandId: string | null): Promise<PositiveReplyFact[]> {
  const rows = (await sql`
    SELECT f.id AS ref, f.org_id, f.brand_id, f.lead_id::text AS lead_id, f.offer_id, f.campaign_id, f.occurred_at
    FROM lead_timeline_facts f
    WHERE f.source = 'reply'
      AND f.detail->>'classification' = 'positive'
      AND f.withdrawn_at IS NULL
      AND f.occurred_at IS NOT NULL
      ${brandId ? sql`AND f.brand_id = ${brandId}` : sql``}
    UNION ALL
    SELECT 'conversion:' || ce.id::text, ce.org_id, ce.brand_id, ce.matched_lead_id::text, NULL, NULL, ce.received_at
    FROM conversion_events ce
    WHERE ce.event = ${CRM_POSITIVE_REPLY_STEP}
      AND ce.source = 'crm'
      AND ce.attribution_status = 'attributed'
      AND ce.withdrawn_at IS NULL
      AND ce.matched_lead_id IS NOT NULL
      AND ce.received_at IS NOT NULL
      ${brandId ? sql`AND ce.brand_id = ${brandId}` : sql``}
  `) as unknown as Array<{
    ref: string;
    org_id: string;
    brand_id: string;
    lead_id: string;
    offer_id: string | null;
    campaign_id: string | null;
    occurred_at: Ts;
  }>;
  return rows.map((r) => ({
    ref: r.ref,
    orgId: r.org_id,
    brandId: r.brand_id,
    leadId: r.lead_id,
    offerId: r.offer_id,
    campaignId: r.campaign_id,
    occurredAt: iso(r.occurred_at) as string,
  }));
}

async function readAnswers(brandId: string | null): Promise<AnswerFact[]> {
  const brandFilterArray = brandId ? sql`AND brand_ids @> ARRAY[${brandId}]::text[]` : sql``;
  const rows = (await sql`
    SELECT 'followup:' || fa.id::text AS ref, 'ai' AS kind, fa.org_id, fa.brand_ids, fa.lead_id::text AS lead_id,
           fa.occurred_at, 'followup_ledger' AS via, fa.acting_campaign_id AS campaign_id
    FROM followup_actions fa
    WHERE fa.action = 'acted' ${brandId ? sql`AND fa.brand_ids @> ARRAY[${brandId}]::text[]` : sql``}
    UNION ALL
    SELECT 'outreach:' || cur.subject_key,
           CASE WHEN cur.raw->'replySent'->>'sentBy' = 'human' THEN 'person' ELSE 'ai' END,
           cur.org_id, cur.brand_ids, cm.lead_id::text, cur.occurred_at, 'reply_sent', NULL
    FROM (
      SELECT DISTINCT ON (subject_key) type, subject_key, occurred_at, lead_email, org_id, brand_ids, raw
      FROM outreach_facts
      WHERE type IN ('reply_sent', 'withdrawn') ${brandFilterArray}
      ORDER BY subject_key, seq DESC
    ) cur
    JOIN lead_contact_methods cm ON cm.channel = 'email' AND lower(cm.value) = lower(cur.lead_email)
    WHERE cur.type = 'reply_sent'
      AND cur.org_id IS NOT NULL
      AND cur.occurred_at IS NOT NULL
      AND cur.raw->'replySent'->>'sentBy' IN ('human', 'automation')
    UNION ALL
    SELECT 'gmail:' || j.gmail_message_id, 'person', j.org_id, ARRAY[j.brand_id], j.lead_id::text, j.sent_at,
           'gmail_answer', NULL
    FROM outside_answer_judgments j
    WHERE j.answers ${brandId ? sql`AND j.brand_id = ${brandId}` : sql``}
    UNION ALL
    SELECT 'answered_outside:' || s.id::text, 'person', s.org_id, ARRAY[s.brand_id], s.lead_id::text, s.stated_at,
           'answered_outside', NULL
    FROM answered_outside_statements s
    ${brandId ? sql`WHERE s.brand_id = ${brandId}` : sql``}
  `) as unknown as Array<{
    ref: string;
    kind: AnswerKind;
    org_id: string;
    brand_ids: string[];
    lead_id: string;
    occurred_at: Ts;
    via: string;
    campaign_id: string | null;
  }>;
  return rows.map((r) => ({
    ref: r.ref,
    kind: r.kind,
    orgId: r.org_id,
    brandIds: r.brand_ids,
    leadId: r.lead_id,
    occurredAt: iso(r.occurred_at) as string,
    via: r.via,
    campaignId: r.campaign_id,
  }));
}

interface CampaignRow {
  id?: string;
  brandIds?: string[] | null;
  brandId?: string | null;
  offerId?: string | null;
  legKey?: string | null;
  featureSlug?: string | null;
  status?: string | null;
}

/** Every campaign of one org, as campaign-service states it. Unreachable = the read fails (502). */
async function fetchOrgCampaignCards(orgId: string): Promise<CampaignCard[]> {
  let response: Response;
  try {
    response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/campaigns`, {
      method: "GET",
      headers: { "X-API-Key": CAMPAIGN_SERVICE_API_KEY, "x-org-id": orgId },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new MeetingAttributionUnavailableError(`campaign-service unreachable for org ${orgId}: ${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new MeetingAttributionUnavailableError(
      `campaign-service /campaigns failed for org ${orgId} (${response.status}): ${await response.text()}`,
    );
  }
  const data = (await response.json()) as { campaigns?: CampaignRow[] };
  if (!Array.isArray(data.campaigns)) {
    throw new MeetingAttributionUnavailableError(`campaign-service /campaigns returned no campaigns array for org ${orgId}`);
  }
  return data.campaigns
    .filter((c): c is CampaignRow & { id: string } => typeof c?.id === "string")
    .map((c) => ({
      id: c.id,
      orgId,
      brandIds: [...new Set([...(c.brandIds ?? []), ...(c.brandId ? [c.brandId] : [])])],
      offerId: c.offerId ?? null,
      legKey: c.legKey ?? null,
      featureSlug: c.featureSlug ?? null,
      status: c.status ?? null,
    }));
}

export interface MeetingAttributionInputs {
  meetings: MeetingFact[];
  positiveReplies: PositiveReplyFact[];
  answers: AnswerFact[];
  campaigns: CampaignCard[];
}

/** Every fact the rule reads, fleet-wide (`brandId` null) or one brand. */
export async function readMeetingAttributionInputs(brandId: string | null): Promise<MeetingAttributionInputs> {
  const [meetings, positiveReplies, answers] = await Promise.all([
    readMeetings(brandId),
    readPositiveReplies(brandId),
    readAnswers(brandId),
  ]);
  // campaign-service is asked only for orgs where a side has to be named.
  const orgIds = [...new Set([...positiveReplies.map((r) => r.orgId), ...answers.map((a) => a.orgId)])].sort();
  const campaigns = (await Promise.all(orgIds.map(fetchOrgCampaignCards))).flat();
  return { meetings, positiveReplies, answers, campaigns };
}

/** Fleet-wide (`brandId` null) or one brand. */
export async function readMeetingAttribution(params: {
  brandId: string | null;
  since: string | null;
}): Promise<MeetingAttributionResult> {
  const inputs = await readMeetingAttributionInputs(params.brandId);
  return attributeMeetings({ ...inputs, since: params.since });
}
