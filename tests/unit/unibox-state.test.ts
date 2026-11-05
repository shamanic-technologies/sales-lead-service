import { describe, it, expect, vi } from "vitest";

// AGENT-READS-LEAD-1105: the pure parts of the one-lead Unibox state (who acted last, counts, next follow-up).
vi.mock("../../src/db/index.js", () => ({ db: { execute: vi.fn() } }));
vi.mock("../../src/config.js", () => ({}));
const { lastActionOf, messageCountsOf, nextFollowupOf } = await import("../../src/lib/unibox-state.js");

describe("lastActionOf", () => {
  it("Edmund (prod 2026-11-04): replied 11-02, we answered 11-04 = ours", () => {
    expect(lastActionOf("2026-11-04T18:54:18.000Z", "2026-11-02T13:22:45.000Z")).toEqual({ side: "ours", at: "2026-11-04T18:54:18.000Z" });
  });
  it("their newer word = theirs; nothing = null; a tie = ours", () => {
    expect(lastActionOf("2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z")).toEqual({ side: "theirs", at: "2026-11-02T00:00:00.000Z" });
    expect(lastActionOf(null, null)).toBeNull();
    expect(lastActionOf(null, "2026-11-02T00:00:00.000Z")?.side).toBe("theirs");
    expect(lastActionOf("2026-11-02T00:00:00.000Z", "2026-11-02T00:00:00.000Z")?.side).toBe("ours");
  });
});

describe("messageCountsOf", () => {
  it("folds each kind into ours / theirs", () => {
    expect(messageCountsOf({ sequenceEmails: 1, emailAnswers: 3, emailReplies: 1, otherChannelsOurs: 2, otherChannelsTheirs: 4 })).toMatchObject({ ours: 6, theirs: 5 });
  });
});

describe("nextFollowupOf", () => {
  it("earliest dated row; a stopped person serves at null; none = null", () => {
    expect(nextFollowupOf([])).toBeNull();
    expect(
      nextFollowupOf([
        { next_followup_at: "2026-11-20 00:00:00+00", basis: "stated", reason: "x" },
        { next_followup_at: "2026-11-11 18:54:18+00", basis: "send", reason: "Last email send + 7 days" },
      ]),
    ).toEqual({ at: "2026-11-11T18:54:18.000Z", basis: "send", reason: "Last email send + 7 days" });
    expect(nextFollowupOf([{ next_followup_at: null, basis: "stopped", reason: "opted out" }])).toEqual({ at: null, basis: "stopped", reason: "opted out" });
  });
});
