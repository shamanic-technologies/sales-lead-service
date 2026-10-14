import { describe, expect, it } from "vitest";
import type { AnswerFact, CampaignCard, MeetingFact, PositiveReplyFact } from "../../src/lib/meeting-attribution.js";
import { splitAtGoLive } from "../../src/lib/meeting-booking-before-after.js";

const ORG = "org-1";
const BRAND = "brand-1";
const OFFER = "offer-1";
const NOW = "2026-12-31T00:00:00.000Z";

const aiMb: CampaignCard = { id: "ai-mb", orgId: ORG, brandIds: [BRAND], offerId: OFFER, legKey: "conversation_to_meeting_booked", featureSlug: "ai-meeting-booking", status: "ongoing" };
const instantCall: CampaignCard = { id: "call", orgId: ORG, brandIds: [BRAND], offerId: OFFER, legKey: "conversation_to_booking_call", featureSlug: "ai-instant-call", status: "ongoing" };

const reply = (leadId: string, at: string, brandId = BRAND): PositiveReplyFact => ({
  ref: `reply:${leadId}:${at}`, orgId: ORG, brandId, leadId, offerId: OFFER, campaignId: "outreach", occurredAt: at,
});
const act = (leadId: string, at: string, campaignId: string, via = "followup_ledger"): AnswerFact => ({
  ref: `${via}:${leadId}:${at}`, kind: "ai", orgId: ORG, brandIds: [BRAND], leadId, occurredAt: at, via, campaignId,
});
const person = (leadId: string, at: string): AnswerFact => ({
  ref: `reply_sent:${leadId}:${at}`, kind: "person", orgId: ORG, brandIds: [BRAND], leadId, occurredAt: at, via: "reply_sent", campaignId: null,
});
const meeting = (id: string, leadId: string | null, at: string | null, over: Partial<MeetingFact> = {}): MeetingFact => ({
  conversionEventId: id, orgId: ORG, brandId: BRAND, event: "meeting_booked", source: "crm", email: null,
  occurredAt: at, leadId, attributionStatus: leadId ? "attributed" : "unmatched", ...over,
});

describe("splitAtGoLive", () => {
  it("go-live = the first AI Meeting Booking act; people split by their FIRST positive reply", () => {
    const r = splitAtGoLive({
      nowIso: NOW,
      campaigns: [aiMb, instantCall],
      positiveReplies: [
        reply("B1", "2026-08-01T00:00:00.000Z"),
        reply("B2", "2026-08-05T00:00:00.000Z"),
        reply("A1", "2026-09-10T00:00:00.000Z"),
        reply("A1", "2026-08-20T00:00:00.000Z"), // A1's FIRST reply is before go-live
        reply("A2", "2026-09-15T00:00:00.000Z"),
      ],
      answers: [
        act("X", "2026-08-25T00:00:00.000Z", "call"), // another leg: not go-live
        act("A2", "2026-09-15T01:00:00.000Z", "ai-mb"),
        act("A1", "2026-09-01T00:00:00.000Z", "ai-mb"),
        person("B1", "2026-08-02T00:00:00.000Z"),
      ],
      meetings: [
        meeting("m1", "B1", "2026-08-10T00:00:00.000Z"),
        meeting("m2", "A2", "2026-09-20T00:00:00.000Z"),
      ],
    });
    const b = r.brands[0];
    expect(b.goLive).toEqual({ at: "2026-09-01T00:00:00.000Z", basis: "first_ai_meeting_booking_act", actRef: "followup_ledger:A1:2026-09-01T00:00:00.000Z", campaignId: "ai-mb" });
    expect(b.positiveReplyPeople).toBe(4);
    expect(b.before).toMatchObject({ people: 3, booked: 1, rate: 1 / 3, bookedAfterGoLive: 0 });
    expect(b.before.bookedBy.yourTeamMeetingBooking).toBe(1);
    expect(b.after).toMatchObject({ people: 1, booked: 1, rate: 1, bookedAfterGoLive: 0 });
    expect(b.after.bookedBy.aiMeetingBooking).toBe(1);
    expect(r.fleet).toMatchObject({ brands: 1, before: { people: 3, booked: 1 }, after: { people: 1, booked: 1 } });
  });

  it("a person who replied before go-live and booked after stays in before, counted in bookedAfterGoLive", () => {
    const r = splitAtGoLive({
      nowIso: NOW,
      campaigns: [aiMb],
      positiveReplies: [reply("B1", "2026-08-01T00:00:00.000Z")],
      answers: [act("B1", "2026-09-01T00:00:00.000Z", "ai-mb")],
      meetings: [meeting("m1", "B1", "2026-09-03T00:00:00.000Z")],
    });
    expect(r.brands[0].before).toMatchObject({ people: 1, booked: 1, bookedAfterGoLive: 1, bookedBy: { aiMeetingBooking: 1 } });
    expect(r.brands[0].after.people).toBe(0);
  });

  it("AI on from day one: listed with an empty before side", () => {
    const r = splitAtGoLive({
      nowIso: NOW,
      campaigns: [aiMb],
      positiveReplies: [reply("A1", "2026-09-10T00:00:00.000Z")],
      // The AI's first act predates every positive reply of the brand (it answered another reply).
      answers: [act("X", "2026-09-01T00:00:00.000Z", "ai-mb"), act("A1", "2026-09-10T01:00:00.000Z", "ai-mb")],
      meetings: [],
    });
    expect(r.brands).toHaveLength(1);
    expect(r.brands[0].before).toMatchObject({ people: 0, booked: 0, rate: null });
    expect(r.brands[0].after).toMatchObject({ people: 1, booked: 0, rate: 0 });
  });

  it("a campaign that never acted: goLive null, everyone before, out of the fleet roll-up", () => {
    const r = splitAtGoLive({
      nowIso: NOW,
      campaigns: [aiMb],
      positiveReplies: [reply("B1", "2026-08-01T00:00:00.000Z")],
      answers: [],
      meetings: [],
    });
    expect(r.brands[0]).toMatchObject({ goLive: null, goLiveUnknownReason: "no_ai_meeting_booking_act", before: { people: 1, bookedAfterGoLive: null } });
    expect(r.fleet.brands).toBe(0);
    expect(r.fleet.before.people).toBe(0);
  });

  it("a brand with no AI Meeting Booking campaign is not listed", () => {
    const r = splitAtGoLive({ nowIso: NOW, campaigns: [instantCall], positiveReplies: [reply("B1", "2026-08-01T00:00:00.000Z")], answers: [], meetings: [] });
    expect(r.brands).toEqual([]);
  });

  it("meetings with no person or no date are in no window; a meeting before any positive reply is in no rate", () => {
    const r = splitAtGoLive({
      nowIso: NOW,
      campaigns: [aiMb],
      positiveReplies: [reply("B1", "2026-08-01T00:00:00.000Z")],
      answers: [act("B1", "2026-09-01T00:00:00.000Z", "ai-mb")],
      meetings: [
        meeting("a", null, "2026-08-05T00:00:00.000Z"),
        meeting("b", null, "2026-08-05T00:00:00.000Z", { attributionStatus: "needs_review" }),
        meeting("c", "B1", null),
        meeting("d", "B1", "2026-07-01T00:00:00.000Z"),
      ],
    });
    const b = r.brands[0];
    expect(b.unplacedMeetings).toEqual({ count: 3, reasons: { person_unknown: 1, match_needs_review: 1, undated: 1 } });
    expect(b.meetingsWithoutPositiveReplyBefore).toBe(1);
    expect(b.before).toMatchObject({ people: 1, booked: 0 });
  });

  it("withinDays compares both windows on the same horizon", () => {
    const r = splitAtGoLive({
      nowIso: "2026-10-01T00:00:00.000Z",
      campaigns: [aiMb],
      positiveReplies: [
        reply("B1", "2026-07-01T00:00:00.000Z"), // books after 40 days: booked, not within 30
        reply("A1", "2026-08-15T00:00:00.000Z"), // mature, books in 5 days
        reply("A2", "2026-09-20T00:00:00.000Z"), // too recent for the horizon
      ],
      answers: [act("A1", "2026-08-01T00:00:00.000Z", "ai-mb")],
      meetings: [
        meeting("m1", "B1", "2026-08-10T00:00:00.000Z"),
        meeting("m2", "A1", "2026-08-20T00:00:00.000Z"),
        meeting("m3", "A2", "2026-09-21T00:00:00.000Z"),
      ],
    });
    const b = r.brands[0];
    expect(b.before).toMatchObject({ people: 1, booked: 1, bookedAfterGoLive: 1, withinDays: { days: 30, people: 1, booked: 0, rate: 0 } });
    expect(b.after).toMatchObject({ people: 2, booked: 2, withinDays: { people: 1, booked: 1, rate: 1 } });
  });
});
