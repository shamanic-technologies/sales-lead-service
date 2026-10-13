import { describe, expect, it } from "vitest";
import {
  attributeMeetings,
  type AnswerFact,
  type CampaignCard,
  type MeetingFact,
  type PositiveReplyFact,
} from "../../src/lib/meeting-attribution.js";

const ORG = "org-1";
const BRAND = "brand-1";
const OFFER = "offer-1";

const campaigns: CampaignCard[] = [
  { id: "ai-mb", orgId: ORG, brandIds: [BRAND], offerId: OFFER, legKey: "conversation_to_meeting_booked", featureSlug: "ai-meeting-booking", status: "ongoing" },
  { id: "team-old", orgId: ORG, brandIds: [BRAND], offerId: OFFER, legKey: "conversation_to_meeting_booked", featureSlug: "your-team-meeting-booking", status: "stopped" },
  { id: "team", orgId: ORG, brandIds: [BRAND], offerId: OFFER, legKey: "conversation_to_meeting_booked", featureSlug: "your-team-meeting-booking", status: "ongoing" },
  { id: "instant-call", orgId: ORG, brandIds: [BRAND], offerId: OFFER, legKey: "conversation_to_booking_call", featureSlug: "ai-instant-call", status: "ongoing" },
];

const reply = (leadId: string, at: string, ref = `reply:${leadId}:${at}`): PositiveReplyFact => ({
  ref, orgId: ORG, brandId: BRAND, leadId, offerId: OFFER, campaignId: "outreach", occurredAt: at,
});
const ai = (leadId: string, at: string, campaignId: string | null, via = "followup_ledger"): AnswerFact => ({
  ref: `${via}:${leadId}:${at}`, kind: "ai", orgId: ORG, brandIds: [BRAND], leadId, occurredAt: at, via, campaignId,
});
const person = (leadId: string, at: string, via = "reply_sent"): AnswerFact => ({
  ref: `${via}:${leadId}:${at}`, kind: "person", orgId: ORG, brandIds: [BRAND], leadId, occurredAt: at, via, campaignId: null,
});
const meeting = (id: string, leadId: string | null, at: string | null, over: Partial<MeetingFact> = {}): MeetingFact => ({
  conversionEventId: id, orgId: ORG, brandId: BRAND, event: "meeting_booked", source: "crm", email: null,
  occurredAt: at, leadId, attributionStatus: leadId ? "attributed" : "unmatched", ...over,
});

describe("attributeMeetings", () => {
  it("a meeting after our AI answered a positive reply is booked by AI Meeting Booking", () => {
    const r = attributeMeetings({
      meetings: [meeting("m1", "L1", "2026-10-05T10:00:00.000Z")],
      positiveReplies: [reply("L1", "2026-10-01T10:00:00.000Z")],
      answers: [ai("L1", "2026-10-01T11:00:00.000Z", "ai-mb")],
      campaigns,
    });
    expect(r.attributedMeetings[0]).toMatchObject({
      arm: "aiMeetingBooking",
      unknownReason: null,
      leadId: "L1",
      positiveReply: { ref: "reply:L1:2026-10-01T10:00:00.000Z" },
      bookedBy: { kind: "ai", campaignId: "ai-mb", featureSlug: "ai-meeting-booking", legKey: "conversation_to_meeting_booked" },
    });
    expect(r.summary.arms.aiMeetingBooking).toEqual({ handled: 1, booked: 1, rate: 1 });
  });

  it("the client's team answering by hand books it as Your Team, under the ongoing Your Team campaign of the offer", () => {
    const r = attributeMeetings({
      meetings: [meeting("m1", "L1", "2026-10-05T10:00:00.000Z")],
      positiveReplies: [reply("L1", "2026-10-01T10:00:00.000Z")],
      answers: [person("L1", "2026-10-02T10:00:00.000Z", "gmail_answer")],
      campaigns,
    });
    expect(r.attributedMeetings[0]).toMatchObject({
      arm: "yourTeamMeetingBooking",
      bookedBy: { kind: "person", campaignId: "team", featureSlug: "your-team-meeting-booking", answerVia: "gmail_answer" },
    });
  });

  it("the LATEST answer before the meeting decides; answers after the meeting do not", () => {
    const r = attributeMeetings({
      meetings: [meeting("m1", "L1", "2026-10-05T10:00:00.000Z")],
      positiveReplies: [reply("L1", "2026-10-01T10:00:00.000Z")],
      answers: [
        ai("L1", "2026-10-01T11:00:00.000Z", "ai-mb"),
        person("L1", "2026-10-03T10:00:00.000Z"),
        ai("L1", "2026-10-06T10:00:00.000Z", "ai-mb"),
      ],
      campaigns,
    });
    expect(r.attributedMeetings[0].arm).toBe("yourTeamMeetingBooking");
    expect(r.summary.arms.yourTeamMeetingBooking).toEqual({ handled: 1, booked: 1, rate: 1 });
    expect(r.summary.arms.aiMeetingBooking.handled).toBe(0);
  });

  it("an answer BEFORE the positive reply is not handling it", () => {
    const r = attributeMeetings({
      meetings: [meeting("m1", "L1", "2026-10-05T10:00:00.000Z")],
      positiveReplies: [reply("L1", "2026-10-03T10:00:00.000Z")],
      answers: [ai("L1", "2026-10-01T11:00:00.000Z", "ai-mb")],
      campaigns,
    });
    expect(r.attributedMeetings[0]).toMatchObject({ arm: "unknown", unknownReason: "no_answer_before_meeting" });
    expect(r.summary.unhandled).toEqual({ people: 1, booked: 1 });
  });

  it("names every unknown: no person, held match, undated, no positive reply before", () => {
    const r = attributeMeetings({
      meetings: [
        meeting("a", null, "2026-10-05T10:00:00.000Z"),
        meeting("b", null, "2026-10-05T10:00:00.000Z", { attributionStatus: "needs_review" }),
        meeting("c", "L1", null),
        meeting("d", "L2", "2026-10-05T10:00:00.000Z"),
      ],
      positiveReplies: [reply("L2", "2026-10-06T10:00:00.000Z")],
      answers: [],
      campaigns,
    });
    expect(r.attributedMeetings.map((m) => [m.conversionEventId, m.unknownReason])).toEqual(
      expect.arrayContaining([
        ["a", "person_unknown"],
        ["b", "match_needs_review"],
        ["c", "undated"],
        ["d", "no_positive_reply_before"],
      ]),
    );
    expect(r.summary.meetings).toMatchObject({ total: 4, unknown: 4, aiMeetingBooking: 0, yourTeamMeetingBooking: 0 });
  });

  it("an automation reply takes the campaign of the ledger act it records; alone it is ai_campaign_unknown", () => {
    const twin = attributeMeetings({
      meetings: [meeting("m1", "L1", "2026-10-05T10:00:00.000Z")],
      positiveReplies: [reply("L1", "2026-10-01T10:00:00.000Z")],
      answers: [
        ai("L1", "2026-10-01T11:00:00.000Z", "ai-mb"),
        ai("L1", "2026-10-01T11:00:30.000Z", null, "reply_sent"),
      ],
      campaigns,
    });
    expect(twin.attributedMeetings[0]).toMatchObject({ arm: "aiMeetingBooking", bookedBy: { answerVia: "reply_sent", campaignId: "ai-mb" } });

    const alone = attributeMeetings({
      meetings: [meeting("m1", "L1", "2026-10-05T10:00:00.000Z")],
      positiveReplies: [reply("L1", "2026-10-01T10:00:00.000Z")],
      answers: [ai("L1", "2026-10-01T11:00:00.000Z", null, "reply_sent")],
      campaigns,
    });
    expect(alone.attributedMeetings[0]).toMatchObject({ arm: "unknown", unknownReason: "ai_campaign_unknown" });
    expect(alone.summary.arms.unknown).toEqual({ handled: 1, booked: 1, rate: 1 });
  });

  it("a queued automation send takes the ONE campaign whose earlier acts it delivers; two campaigns = unknown", () => {
    const one = attributeMeetings({
      meetings: [meeting("m1", "L1", "2026-10-05T10:00:00.000Z")],
      positiveReplies: [reply("L1", "2026-10-01T10:00:00.000Z")],
      answers: [ai("L1", "2026-10-01T11:00:00.000Z", "ai-mb"), ai("L1", "2026-10-01T15:00:00.000Z", null, "reply_sent")],
      campaigns,
    });
    expect(one.attributedMeetings[0]).toMatchObject({ arm: "aiMeetingBooking", bookedBy: { answerVia: "reply_sent", campaignId: "ai-mb" } });

    const two = attributeMeetings({
      meetings: [meeting("m1", "L1", "2026-10-05T10:00:00.000Z")],
      positiveReplies: [reply("L1", "2026-10-01T10:00:00.000Z")],
      answers: [
        ai("L1", "2026-10-01T11:00:00.000Z", "ai-mb"),
        ai("L1", "2026-10-01T11:30:00.000Z", "instant-call"),
        ai("L1", "2026-10-01T15:00:00.000Z", null, "reply_sent"),
      ],
      campaigns,
    });
    expect(two.attributedMeetings[0]).toMatchObject({ arm: "unknown", unknownReason: "ai_campaign_unknown" });
  });

  it("an AI act of another leg is reported as other, never as AI Meeting Booking", () => {
    const r = attributeMeetings({
      meetings: [meeting("m1", "L1", "2026-10-05T10:00:00.000Z")],
      positiveReplies: [reply("L1", "2026-10-01T10:00:00.000Z")],
      answers: [ai("L1", "2026-10-01T11:00:00.000Z", "instant-call")],
      campaigns,
    });
    expect(r.attributedMeetings[0].arm).toBe("other");
    expect(r.summary.arms.other).toEqual([
      { featureSlug: "ai-instant-call", legKey: "conversation_to_booking_call", handled: 1, booked: 1, rate: 1 },
    ]);
  });

  it("partitions the people who replied positively, with populations beside counts, per brand and fleet", () => {
    const r = attributeMeetings({
      meetings: [meeting("m1", "L1", "2026-10-05T10:00:00.000Z")],
      positiveReplies: [
        reply("L1", "2026-10-01T10:00:00.000Z"),
        reply("L2", "2026-10-01T10:00:00.000Z"),
        reply("L3", "2026-10-01T10:00:00.000Z"),
        reply("L3", "2026-10-02T10:00:00.000Z"),
        reply("L4", "2026-10-01T10:00:00.000Z"),
      ],
      answers: [
        ai("L1", "2026-10-01T11:00:00.000Z", "ai-mb"),
        ai("L2", "2026-10-01T11:00:00.000Z", "ai-mb"),
        person("L3", "2026-10-01T11:00:00.000Z"),
      ],
      campaigns,
    });
    expect(r.summary.positiveReplyPeople).toBe(4);
    expect(r.summary.arms.aiMeetingBooking).toEqual({ handled: 2, booked: 1, rate: 0.5 });
    expect(r.summary.arms.yourTeamMeetingBooking).toEqual({ handled: 1, booked: 0, rate: 0 });
    expect(r.summary.unhandled).toEqual({ people: 1, booked: 0 });
    expect(r.byBrand).toHaveLength(1);
    expect(r.byBrand[0]).toMatchObject({ orgId: ORG, brandId: BRAND, positiveReplyPeople: 4 });
  });

  it("since keeps people whose first positive reply, and meetings, are at or after it", () => {
    const r = attributeMeetings({
      meetings: [meeting("old", "L1", "2026-09-05T10:00:00.000Z"), meeting("new", "L2", "2026-10-05T10:00:00.000Z")],
      positiveReplies: [reply("L1", "2026-09-01T10:00:00.000Z"), reply("L2", "2026-10-01T10:00:00.000Z")],
      answers: [person("L1", "2026-09-02T10:00:00.000Z"), ai("L2", "2026-10-02T10:00:00.000Z", "ai-mb")],
      campaigns,
      since: "2026-09-21T00:00:00.000Z",
    });
    expect(r.attributedMeetings.map((m) => m.conversionEventId)).toEqual(["new"]);
    expect(r.summary.positiveReplyPeople).toBe(1);
    expect(r.summary.arms.aiMeetingBooking).toEqual({ handled: 1, booked: 1, rate: 1 });
  });
});
