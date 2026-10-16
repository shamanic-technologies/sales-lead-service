import { describe, expect, it } from "vitest";
import { decideProspectFollowup, type ProspectFollowupFacts } from "../../src/lib/prospect-followup.js";
import { pureProspectAllows } from "../../src/lib/relationship-tags.js";
import { EMPTY_RELATIONSHIP, type RelationshipBlock } from "../../src/lib/relationship-read.js";

function rel(p: Partial<RelationshipBlock> & { openMerge?: boolean } = {}): RelationshipBlock {
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
    policies: { business_only: false, pure_prospect: pureProspectAllows({ subject, tags, unsureTags, judgedAt, openMerge: p.openMerge ?? false }) },
  };
}

function facts(over: Partial<ProspectFollowupFacts> = {}): ProspectFollowupFacts {
  return {
    labels: new Set(["initial_email", "opened"]),
    outcomes: new Set(),
    human: null,
    disqualified: false,
    sender: { queued: false, unsubscribed: false, bounced: false },
    relationship: rel(),
    waitingOnAnswer: false,
    ...over,
  };
}

describe("prospect follow-up verdict (NEVER-NO-FOLLOWUP-1014)", () => {
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
    ["customer", facts({ outcomes: new Set(["sale"]) }), "customer"],
    ["meeting booked", facts({ outcomes: new Set(["meeting_booked"]) }), "meeting_booked"],
    ["positive reply (reply label)", facts({ labels: new Set(["initial_email", "interested"]) }), "positive_reply"],
    ["positive reply (CRM form)", facts({ outcomes: new Set(["positive_reply"]) }), "positive_reply"],
    ["waiting on an answer", facts({ waitingOnAnswer: true }), "in_conversation"],
    ["never emailed", facts({ labels: new Set() }), "not_contacted"],
    ["sequence still sending", facts({ sender: { queued: true, unsubscribed: false, bounced: false } }), "sequence_running"],
    ["no human yet", facts({ relationship: null }), "identity_unresolved"],
    ["known subject never judged", facts({ relationship: rel({ subject: true }) }), "relationship_not_judged"],
    ["open same-person question", facts({ relationship: rel({ openMerge: true }) }), "same_person_question_open"],
  ])("%s: not owed", (_name, f, reason) => {
    const v = decideProspectFollowup(f);
    expect(v.owed).toBe(false);
    expect(v.reason).toBe(reason);
  });

  it.each([["personal"], ["customer"], ["investor"], ["team"], ["advisor"], ["supplier"], ["partner"], ["other_professional"], ["journalist"]] as const)(
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
    ["waiting on the responder", facts({ waitingOnAnswer: true }), "2026-10-16T12:00:00.000Z"],
    ["subject never judged", facts({ relationship: rel({ subject: true }) }), "2026-10-15T12:00:00.000Z"],
    ["no human yet", facts({ relationship: null }), "2026-10-15T12:00:00.000Z"],
    ["two temporary reasons: the later wait", facts({ waitingOnAnswer: true, sender: { queued: true, unsubscribed: false, bounced: false } }), "2026-10-17T12:00:00.000Z"],
  ])("%s: NOT YET, ask again later (never a dead end)", (_n, f, retryAfter) => {
    expect(decideProspectFollowup(f, NOW)).toMatchObject({ owed: false, kind: "not_yet", retryAfter });
  });

  it.each([
    ["opted out", facts({ human: { optedOut: true, doNotContact: false } })],
    ["disqualified", facts({ disqualified: true })],
    ["positive reply", facts({ outcomes: new Set(["positive_reply"]) })],
    ["tagged personal", facts({ relationship: rel({ tags: ["personal"] }) })],
    ["never emailed", facts({ labels: new Set() })],
    ["a stop beside a not-yet is a stop", facts({ disqualified: true, sender: { queued: true, unsubscribed: false, bounced: false } })],
  ])("%s: STOP, no retry date", (_n, f) => {
    expect(decideProspectFollowup(f, NOW)).toMatchObject({ owed: false, kind: "stop", retryAfter: null });
  });

  it("an old question is not a stop: only a word newer than our latest answer holds them, as not-yet", () => {
    expect(decideProspectFollowup(facts({ labels: new Set(["initial_email", "question"]) })).kind).toBe("owed");
  });

  it("every stop is listed, strongest first", () => {
    const v = decideProspectFollowup(facts({ disqualified: true, human: { optedOut: true, doNotContact: false }, outcomes: new Set(["meeting_booked"]) }));
    expect(v.reasons).toEqual(["opted_out", "disqualified", "meeting_booked"]);
  });
});
