import { describe, expect, it } from "vitest";
import { ANSWER_RETRY_BASE_MS, ANSWER_RETRY_CAP_MS, answerRetryDelayMs, decideProspectFollowup, type ProspectFollowupFacts } from "../../src/lib/prospect-followup.js";
import { prospectFollowupAllows, pureProspectAllows } from "../../src/lib/relationship-tags.js";
import { EMPTY_RELATIONSHIP, type RelationshipBlock } from "../../src/lib/relationship-read.js";

function rel(p: Partial<RelationshipBlock> & { hasDirect?: boolean } = {}): RelationshipBlock {
  const tags = p.tags ?? [];
  const unsureTags = p.unsureTags ?? [];
  const judgedAt = p.judgedAt === undefined ? null : p.judgedAt;
  const subject = p.subject ?? false;
  return {
    ...EMPTY_RELATIONSHIP,
    humanId: "h1",
    tags,
    unsureTags,
    judgedAt,
    subject,
    policies: {
      business_only: false,
      pure_prospect: pureProspectAllows({ subject, hasDirect: p.hasDirect ?? true, tags, unsureTags, judgedAt }),
      prospect_followup: prospectFollowupAllows({ subject, hasDirect: p.hasDirect ?? true, tags, unsureTags, judgedAt }),
    },
  };
}

function facts(over: Partial<ProspectFollowupFacts> = {}): ProspectFollowupFacts {
  return {
    labels: new Set(["initial_email", "opened"]),
    human: null,
    disqualified: false,
    sender: { queued: false, unsubscribed: false, bounced: false },
    relationship: rel(),
    waitingOnAnswer: false,
    ...over,
  };
}

describe("prospect follow-up verdict (NEVER-NO-FOLLOWUP-1014)", () => {
  it("a member of the org owning the brand is its team: never owed, for good (TEAM-OUT-OF-UNIBOX-1017)", () => {
    const v = decideProspectFollowup(facts({ teamMember: true }));
    expect(v).toMatchObject({ owed: false, kind: "stop", reason: "team_member", reasons: ["team_member"] });
    // "team" wins over every other tag: a member who also paid is still a stop for being the team.
    expect(decideProspectFollowup(facts({ teamMember: true, human: { optedOut: true, doNotContact: false } })).reasons).toEqual(["team_member", "opted_out"]);
  });

  it("a contacted person no source of the org knows is a pure prospect: owed", () => {
    expect(decideProspectFollowup(facts())).toEqual({ owed: true, kind: "owed", retryAfter: null, reason: null, reasons: [], relationshipTags: [] });
  });

  it("a judged subject tagged only prospect is owed; a plain no thanks is not a stop", () => {
    const v = decideProspectFollowup(facts({ labels: new Set(["followup", "not_interested"]), relationship: rel({ subject: true, judgedAt: "2026-10-14T00:00:00Z", tags: ["prospect"] }) }));
    expect(v.owed).toBe(true);
  });

  it.each([
    ["opted out (human fact)", facts({ human: { optedOut: true, doNotContact: false } }), "opted_out"],
    ["opted out (reply)", facts({ labels: new Set(["initial_email", "opt_out"]) }), "opted_out"],
    ["do not contact", facts({ human: { optedOut: false, doNotContact: true } }), "do_not_contact"],
    ["unsubscribed (sender)", facts({ sender: { queued: false, unsubscribed: true, bounced: false } }), "unsubscribed"],
    ["bounced (fact)", facts({ labels: new Set(["initial_email", "bounced"]) }), "bounced"],
    ["disqualified", facts({ disqualified: true }), "disqualified"],
    ["waiting on an answer", facts({ waitingOnAnswer: true }), "in_conversation"],
    ["never emailed", facts({ labels: new Set() }), "not_contacted"],
    ["sequence still sending", facts({ sender: { queued: true, unsubscribed: false, bounced: false } }), "sequence_running"],
    ["no human yet", facts({ relationship: null }), "identity_unresolved"],
    ["known subject never judged", facts({ relationship: rel({ subject: true }) }), "relationship_not_judged"],
  ])("%s: not owed", (_name, f, reason) => {
    const v = decideProspectFollowup(f);
    expect(v.owed).toBe(false);
    expect(v.reason).toBe(reason);
  });

  it.each([
    ["positive reply", facts({ labels: new Set(["initial_email", "interested"]) })],
    ["meeting booked", facts({ labels: new Set(["initial_email", "meeting_booked"]) })],
    ["meeting held", facts({ labels: new Set(["initial_email", "interested", "meeting_booked", "meeting_attended"]) })],
    ["paying client", facts({ labels: new Set(["initial_email", "paid_client"]) })],
    ["tagged customer (yes or unsure)", facts({ relationship: rel({ subject: true, judgedAt: "2026-10-14T00:00:00Z", tags: ["customer", "prospect"] }) })],
    ["tagged customer, unsure", facts({ relationship: rel({ subject: true, judgedAt: "2026-10-14T00:00:00Z", unsureTags: ["customer"] }) })],
    ["Lukas: meeting held, then asked to be followed up", facts({ labels: new Set(["initial_email", "interested", "meeting_booked", "meeting_attended"]), relationship: rel({ unsureTags: ["customer"] }) })],
  ])("a funnel stage is never a stop (FOLLOWUP-FUNNEL-STAGE-1109): %s is owed, the campaign decides", (_n, f) => {
    expect(decideProspectFollowup(f)).toMatchObject({ owed: true, kind: "owed", reasons: [], relationshipTags: [] });
  });

  it.each([["personal"], ["investor"], ["team"], ["advisor"], ["supplier"], ["partner"], ["other_professional"], ["journalist"]] as const)(
    "tagged %s (yes or unsure): not a pure prospect",
    (tag) => {
      for (const block of [rel({ subject: true, judgedAt: "2026-10-14T00:00:00Z", tags: [tag, "prospect"] }), rel({ subject: true, judgedAt: "2026-10-14T00:00:00Z", unsureTags: [tag] }), rel({ tags: [tag] })]) {
        const v = decideProspectFollowup(facts({ relationship: block }));
        expect(v).toMatchObject({ owed: false, reason: "not_pure_prospect", relationshipTags: [tag] });
      }
    },
  );

  const NOW = new Date("2026-10-14T12:00:00Z");
  it.each([
    ["sequence still sending", facts({ sender: { queued: true, unsubscribed: false, bounced: false } }), "2026-10-17T12:00:00.000Z"],
    ["waiting on our answer: retried soon, never parked (ANSWER-RETRY-1106)", facts({ waitingOnAnswer: true }), "2026-10-14T12:15:00.000Z"],
    ["subject never judged", facts({ relationship: rel({ subject: true }) }), "2026-10-15T12:00:00.000Z"],
    ["no human yet", facts({ relationship: null }), "2026-10-15T12:00:00.000Z"],
    ["two temporary reasons: the later wait", facts({ sender: { queued: true, unsubscribed: false, bounced: false }, relationship: null }), "2026-10-17T12:00:00.000Z"],
    ["waiting on our answer beside a queued step: our answer's turn, never 72 h", facts({ waitingOnAnswer: true, sender: { queued: true, unsubscribed: false, bounced: false } }), "2026-10-14T12:15:00.000Z"],
  ])("%s: NOT YET, ask again later (never a dead end)", (_n, f, retryAfter) => {
    expect(decideProspectFollowup(f, NOW)).toMatchObject({ owed: false, kind: "not_yet", retryAfter });
  });

  it.each([
    ["opted out", facts({ human: { optedOut: true, doNotContact: false } })],
    ["disqualified", facts({ disqualified: true })],
    ["tagged personal", facts({ relationship: rel({ tags: ["personal"] }) })],
    ["never emailed", facts({ labels: new Set() })],
    ["a stop beside a not-yet is a stop", facts({ disqualified: true, sender: { queued: true, unsubscribed: false, bounced: false } })],
  ])("%s: STOP, no retry date", (_n, f) => {
    expect(decideProspectFollowup(f, NOW)).toMatchObject({ owed: false, kind: "stop", retryAfter: null });
  });

  it("answering retries back off: 15 min doubling per unanswered attempt, capped at 4 h, equal jitter (ANSWER-RETRY-1106)", () => {
    const top = () => 1;
    const bottom = () => 0;
    expect([0, 1, 2, 3, 4, 5, 9, 200].map((n) => answerRetryDelayMs(n, top) / 60_000)).toEqual([15, 30, 60, 120, 240, 240, 240, 240]);
    expect([0, 1, 4, 9].map((n) => answerRetryDelayMs(n, bottom) / 60_000)).toEqual([7.5, 15, 120, 120]);
    for (let n = 0; n < 12; n++) {
      const d = answerRetryDelayMs(n);
      expect(d).toBeGreaterThanOrEqual(ANSWER_RETRY_BASE_MS / 2);
      expect(d).toBeLessThanOrEqual(ANSWER_RETRY_CAP_MS);
    }
    expect(answerRetryDelayMs(-3, top)).toBe(ANSWER_RETRY_BASE_MS);
  });

  it("an old question is not a stop: only a word newer than our latest answer holds them, as not-yet", () => {
    expect(decideProspectFollowup(facts({ labels: new Set(["initial_email", "question"]) })).kind).toBe("owed");
  });

  it("every stop is listed, strongest first", () => {
    const v = decideProspectFollowup(facts({ disqualified: true, human: { optedOut: true, doNotContact: false }, labels: new Set(["initial_email", "meeting_booked", "bounced"]) }));
    expect(v.reasons).toEqual(["opted_out", "bounced", "disqualified"]);
  });
});
