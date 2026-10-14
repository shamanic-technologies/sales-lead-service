/**
 * A brand's Positive reply -> Meeting booked rate BEFORE its AI Meeting Booking went live and AFTER
 * (owner claim to Doc Dinners 2026-10-12, "+50% booking rate since the auto-replier"; a client email
 * quotes only a served figure). features-service serves it beside the "AI vs your team" gain.
 *
 *   go-live    the brand's FIRST AI Meeting Booking act: the earliest follow-up ledger `acted` row
 *              (`followup_actions`) whose acting campaign campaign-service states is AI Meeting
 *              Booking (channel `ai-meeting-booking`, leg `conversation_to_meeting_booked`) of that
 *              brand. A positive fact, never a campaign creation date (a created campaign is not a
 *              live one). A brand with such a campaign and no act yet: `goLive: null`, every person
 *              is `before` (nobody was answered by the AI), and the brand stays out of the roll-up.
 *   window     a person (lead at the brand) belongs to the window of their FIRST positive reply:
 *              strictly before go-live = `before`, at or after = `after`. before + after = the
 *              brand's positive repliers since inception (`positiveReplyPeople` of
 *              `/internal/meeting-attribution`), asserted on every read.
 *   booked     the person's first meeting at or after that first positive reply, whoever booked it
 *              (the same person-to-meeting rule as meeting-attribution; its side is served in
 *              `bookedBy`). A `before` person who books AFTER go-live stays in `before` (their
 *              window is fixed by the reply) and is counted again in `before.bookedAfterGoLive`.
 *   unplaced   a meeting with no person (unmatched, held for review) or no date is in NO window and
 *              no rate: `unplacedMeetings` with its reasons. A meeting of a person with no positive
 *              reply before it is `meetingsWithoutPositiveReplyBefore`, also in no rate.
 *   horizon    `before` people had more time to book than `after` people. `withinDays` compares on
 *              the same horizon: people whose first positive reply is at least `HORIZON_DAYS` old,
 *              booked within `HORIZON_DAYS` of it.
 */
import {
  AI_MEETING_BOOKING_SLUG,
  MEETING_LEG_KEY,
  attributeMeetings,
  readMeetingAttributionInputs,
  type AttributedMeeting,
  type MeetingAttributionInputs,
  type MeetingArm,
  type MeetingUnknownReason,
} from "./meeting-attribution.js";

export const HORIZON_DAYS = 30;
const DAY_MS = 86_400_000;

export interface GoLive {
  at: string;
  basis: "first_ai_meeting_booking_act";
  actRef: string;
  campaignId: string;
}

export interface WindowCounts {
  /** People whose first positive reply is in this window. */
  people: number;
  /** Of them, people with a meeting at or after that reply. */
  booked: number;
  /** booked / people; null when nobody. */
  rate: number | null;
  /** Who booked each booked person's first meeting (meeting-attribution's side). */
  bookedBy: Record<MeetingArm, number>;
  /** Of `booked`, the first meeting dated at or after go-live (always 0 on `after`, null without go-live). */
  bookedAfterGoLive: number | null;
  /** Same horizon for both windows: first reply at least HORIZON_DAYS old, booked within HORIZON_DAYS. */
  withinDays: { days: number; people: number; booked: number; rate: number | null };
}

export interface BrandBeforeAfter {
  orgId: string;
  brandId: string;
  goLive: GoLive | null;
  goLiveUnknownReason: "no_ai_meeting_booking_act" | null;
  positiveReplyPeople: number;
  before: WindowCounts;
  after: WindowCounts;
  unplacedMeetings: { count: number; reasons: Partial<Record<MeetingUnknownReason, number>> };
  meetingsWithoutPositiveReplyBefore: number;
}

export interface BeforeAfterResult {
  horizonDays: number;
  brands: BrandBeforeAfter[];
  /** Brands with a go-live only. */
  fleet: { brands: number; before: WindowCounts; after: WindowCounts };
}

const UNPLACED: ReadonlySet<MeetingUnknownReason> = new Set(["person_unknown", "match_needs_review", "undated"]);

function emptyWindow(withGoLive: boolean): WindowCounts {
  return {
    people: 0,
    booked: 0,
    rate: null,
    bookedBy: { aiMeetingBooking: 0, yourTeamMeetingBooking: 0, other: 0, unknown: 0 },
    bookedAfterGoLive: withGoLive ? 0 : null,
    withinDays: { days: HORIZON_DAYS, people: 0, booked: 0, rate: null },
  };
}

function finishWindow(w: WindowCounts): WindowCounts {
  w.rate = w.people > 0 ? w.booked / w.people : null;
  w.withinDays.rate = w.withinDays.people > 0 ? w.withinDays.booked / w.withinDays.people : null;
  return w;
}

function addWindow(into: WindowCounts, w: WindowCounts): void {
  into.people += w.people;
  into.booked += w.booked;
  for (const arm of Object.keys(w.bookedBy) as MeetingArm[]) into.bookedBy[arm] += w.bookedBy[arm];
  into.bookedAfterGoLive = (into.bookedAfterGoLive ?? 0) + (w.bookedAfterGoLive ?? 0);
  into.withinDays.people += w.withinDays.people;
  into.withinDays.booked += w.withinDays.booked;
}

const ms = (iso: string) => Date.parse(iso);

/** Pure: split every brand that turned AI Meeting Booking on at its go-live. */
export function splitAtGoLive(input: MeetingAttributionInputs & { nowIso: string }): BeforeAfterResult {
  const nowMs = ms(input.nowIso);
  const attribution = attributeMeetings({ ...input, since: null });
  const brandKey = (orgId: string, brandId: string) => `${orgId}|${brandId}`;

  // Brands that turned it on: an AI Meeting Booking campaign of the brand.
  const aiCampaigns = input.campaigns.filter((c) => c.featureSlug === AI_MEETING_BOOKING_SLUG && c.legKey === MEETING_LEG_KEY);
  const listed = new Map<string, { orgId: string; brandId: string }>();
  for (const c of aiCampaigns) for (const b of c.brandIds) listed.set(brandKey(c.orgId, b), { orgId: c.orgId, brandId: b });

  // Go-live: the first ledger act of one of the brand's AI Meeting Booking campaigns.
  const goLives = new Map<string, GoLive>();
  for (const a of input.answers) {
    if (a.kind !== "ai" || a.via !== "followup_ledger" || a.campaignId === null) continue;
    const campaign = aiCampaigns.find((c) => c.id === a.campaignId && c.orgId === a.orgId);
    if (!campaign) continue;
    for (const brandId of a.brandIds) {
      if (!campaign.brandIds.includes(brandId)) continue;
      const k = brandKey(a.orgId, brandId);
      const current = goLives.get(k);
      if (!current || ms(a.occurredAt) < ms(current.at) || (ms(a.occurredAt) === ms(current.at) && a.ref < current.actRef)) {
        goLives.set(k, { at: a.occurredAt, basis: "first_ai_meeting_booking_act", actRef: a.ref, campaignId: a.campaignId });
      }
    }
  }

  // Per person: first positive reply and first placed meeting at or after it.
  const firstReply = new Map<string, { orgId: string; brandId: string; at: string }>();
  for (const r of input.positiveReplies) {
    const k = `${brandKey(r.orgId, r.brandId)}|${r.leadId}`;
    const cur = firstReply.get(k);
    if (!cur || ms(r.occurredAt) < ms(cur.at)) firstReply.set(k, { orgId: r.orgId, brandId: r.brandId, at: r.occurredAt });
  }
  const meetingsByPerson = new Map<string, AttributedMeeting[]>();
  for (const m of attribution.attributedMeetings) {
    if (m.leadId === null || m.occurredAt === null) continue;
    const k = `${brandKey(m.orgId, m.brandId)}|${m.leadId}`;
    const list = meetingsByPerson.get(k) ?? [];
    list.push(m);
    meetingsByPerson.set(k, list);
  }

  const result = new Map<string, BrandBeforeAfter>();
  for (const [k, { orgId, brandId }] of listed) {
    const goLive = goLives.get(k) ?? null;
    result.set(k, {
      orgId,
      brandId,
      goLive,
      goLiveUnknownReason: goLive ? null : "no_ai_meeting_booking_act",
      positiveReplyPeople: 0,
      before: emptyWindow(goLive !== null),
      after: emptyWindow(goLive !== null),
      unplacedMeetings: { count: 0, reasons: {} },
      meetingsWithoutPositiveReplyBefore: 0,
    });
  }

  for (const [personKey, reply] of firstReply) {
    const b = result.get(brandKey(reply.orgId, reply.brandId));
    if (!b) continue;
    b.positiveReplyPeople += 1;
    const replyMs = ms(reply.at);
    const goLiveMs = b.goLive ? ms(b.goLive.at) : null;
    const w = goLiveMs !== null && replyMs >= goLiveMs ? b.after : b.before;
    w.people += 1;
    const first = (meetingsByPerson.get(personKey) ?? [])
      .filter((m) => ms(m.occurredAt as string) >= replyMs)
      .sort((x, y) => ms(x.occurredAt as string) - ms(y.occurredAt as string))[0];
    const mature = replyMs + HORIZON_DAYS * DAY_MS <= nowMs;
    if (mature) w.withinDays.people += 1;
    if (!first) continue;
    const meetingMs = ms(first.occurredAt as string);
    w.booked += 1;
    w.bookedBy[first.arm] += 1;
    if (goLiveMs !== null && meetingMs >= goLiveMs && w === b.before) w.bookedAfterGoLive = (w.bookedAfterGoLive ?? 0) + 1;
    if (mature && meetingMs <= replyMs + HORIZON_DAYS * DAY_MS) w.withinDays.booked += 1;
  }

  for (const m of attribution.attributedMeetings) {
    const b = result.get(brandKey(m.orgId, m.brandId));
    if (!b || m.unknownReason === null) continue;
    if (UNPLACED.has(m.unknownReason)) {
      b.unplacedMeetings.count += 1;
      b.unplacedMeetings.reasons[m.unknownReason] = (b.unplacedMeetings.reasons[m.unknownReason] ?? 0) + 1;
    } else if (m.unknownReason === "no_positive_reply_before") {
      b.meetingsWithoutPositiveReplyBefore += 1;
    }
  }

  const sinceInception = new Map(attribution.byBrand.map((s) => [brandKey(s.orgId, s.brandId), s.positiveReplyPeople]));
  const fleet = { brands: 0, before: emptyWindow(true), after: emptyWindow(true) };
  const brands = [...result.values()].sort((a, b) => a.orgId.localeCompare(b.orgId) || a.brandId.localeCompare(b.brandId));
  for (const b of brands) {
    const expected = sinceInception.get(brandKey(b.orgId, b.brandId)) ?? 0;
    if (b.before.people + b.after.people !== expected || b.positiveReplyPeople !== expected) {
      throw new Error(
        `[meeting-booking-before-after] windows do not reconcile for brand ${b.brandId}: before ${b.before.people} + after ${b.after.people} vs ${expected} positive repliers`,
      );
    }
    finishWindow(b.before);
    finishWindow(b.after);
    if (b.goLive) {
      fleet.brands += 1;
      addWindow(fleet.before, b.before);
      addWindow(fleet.after, b.after);
    }
  }
  fleet.after.bookedAfterGoLive = 0;
  return { horizonDays: HORIZON_DAYS, brands, fleet: { brands: fleet.brands, before: finishWindow(fleet.before), after: finishWindow(fleet.after) } };
}

/** Fleet-wide (`brandId` null) or one brand. */
export async function readMeetingBookingBeforeAfter(params: { brandId: string | null }): Promise<BeforeAfterResult> {
  const inputs = await readMeetingAttributionInputs(params.brandId);
  return splitAtGoLive({ ...inputs, nowIso: new Date().toISOString() });
}
