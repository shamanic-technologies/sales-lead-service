/** UNIBOX-LAST-MESSAGE-PREVIEW-1021: a Unibox row shows the first words of its last message. */
import { describe, expect, it } from "vitest";
import { messagePreview, PREVIEW_MAX_CHARS } from "../../src/lib/unibox-preview.js";
import { lastMessageOfRow, needsAsking, RECHECK_SETTLED_MS, type CrmRelationLatest } from "../../src/lib/unibox-last-message.js";

describe("messagePreview", () => {
  it("serves the start of our follow-up to Andreas on one line, cut on a word", () => {
    const text =
      "Last note from me, Andreas.\n\nIf a call feels like too much right now, there's a lighter option. They run a confidential 90-second assessment, and it comes with a complimentary Enterprise Intelligence Package (valued at $48,400).";
    const got = messagePreview(text)!;
    expect(got.startsWith("Last note from me, Andreas. If a call feels like too much right now")).toBe(true);
    expect(got.length).toBeLessThanOrEqual(PREVIEW_MAX_CHARS + 1);
    expect(got.endsWith("…")).toBe(true);
    expect(got).not.toContain("\n");
  });

  it("drops the quoted history and the signature of a reply", () => {
    const reply = [
      "Thanks Kevin, happy to talk next week.",
      "",
      "--",
      "Ana Lopez | Head of Sales",
      "",
      "On Mon, Oct 13, 2026 at 5:57 PM Kevin <kevin.l@growdistribute.com> wrote:",
      "> Andreas, one more angle.",
    ].join("\r\n");
    expect(messagePreview(reply)).toBe("Thanks Kevin, happy to talk next week.");
    expect(messagePreview("Merci, on en parle jeudi\nLe lun. 13 oct. 2026 à 17:57, Kevin a écrit :\n> bonjour")).toBe("Merci, on en parle jeudi");
    expect(messagePreview("ok\n> quoted line\nsee above")).toBe("ok see above");
  });

  it("is null when nothing of the sender's words is left", () => {
    expect(messagePreview(null)).toBeNull();
    expect(messagePreview("   \n ")).toBeNull();
    expect(messagePreview("On Mon, Oct 13, 2026 at 5:57 PM Kevin wrote:\n> hi")).toBeNull();
  });

  it("keeps a short message whole", () => {
    expect(messagePreview("Sounds good 👍")).toBe("Sounds good 👍");
  });
});

const answer = (relationKey: string, over: Partial<CrmRelationLatest> = {}): CrmRelationLatest => ({ relationKey, status: "no_message", reason: null, message: null, ...over });
const message = (at: string, direction: "inbound" | "outbound", text: string | null) => ({
  at, source: "instantly", channel: "email", direction, sentBy: direction === "outbound" ? ("automation" as const) : null,
  subject: "Data, not docs", text, textBasis: "original", textTruncated: false, from: null,
});

describe("lastMessageOfRow", () => {
  it("serves the latest message over the relations folded into the row (Andreas: our Oct 21 follow-up)", () => {
    const answers = new Map([
      ["r1", answer("r1", { status: "message", message: message("2026-10-13T17:57:50.103Z", "outbound", "Andreas, one more angle.") })],
      ["r2", answer("r2", { status: "message", message: message("2026-10-21T05:08:53.212Z", "outbound", "Last note from me, Andreas.") })],
    ]);
    expect(lastMessageOfRow(["r1", "r2"], answers)).toEqual({
      lastMessage: { at: "2026-10-21T05:08:53.212Z", side: "ours", sentBy: "automation", channel: "email", source: "instantly", subject: "Data, not docs", preview: "Last note from me, Andreas." },
      reason: null,
    });
  });

  it("says why there is none: unreadable before empty, unknown last; a wordless message keeps the subject or says no_text", () => {
    expect(lastMessageOfRow([], new Map())).toEqual({ lastMessage: null, reason: "no_relation" });
    expect(lastMessageOfRow(["a", "b"], new Map([["a", answer("a")], ["b", answer("b", { status: "unreadable", reason: "source_unreadable" })]])).reason).toBe("source_unreadable");
    expect(lastMessageOfRow(["a"], new Map([["a", answer("a")]])).reason).toBe("no_message");
    expect(lastMessageOfRow(["a"], new Map([["a", answer("a", { status: "unknown", reason: "relation_not_found" })]])).reason).toBe("relation_unknown");
    const inbound = lastMessageOfRow(["a"], new Map([["a", answer("a", { status: "message", message: message("2026-10-01T00:00:00Z", "inbound", "  ") })]]));
    expect(inbound).toMatchObject({ lastMessage: { side: "theirs", sentBy: null, preview: "Data, not docs" }, reason: null });
    const blank = lastMessageOfRow(["a"], new Map([["a", answer("a", { status: "message", message: { ...message("2026-10-01T00:00:00Z", "inbound", null), subject: null } })]]));
    expect(blank).toMatchObject({ lastMessage: { preview: null }, reason: "no_text" });
  });
});

describe("needsAsking", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  it("asks a row never asked, one whose activity is recent, and a settled one only every few hours", () => {
    expect(needsAsking(undefined, "2026-10-01T00:00:00Z", now)).toBe(true);
    expect(needsAsking({ checkedAt: "2026-10-21T09:55:00Z", reason: null }, "2026-10-21T09:00:00Z", now)).toBe(true); // crm's store may lag
    expect(needsAsking({ checkedAt: "2026-10-21T09:55:00Z", reason: null }, "2026-10-10T09:00:00Z", now)).toBe(false);
    expect(needsAsking({ checkedAt: new Date(now - RECHECK_SETTLED_MS).toISOString(), reason: null }, "2026-10-10T09:00:00Z", now)).toBe(true);
    expect(needsAsking({ checkedAt: "2026-10-21T09:00:00Z", reason: "source_unreadable" }, "2026-10-10T09:00:00Z", now)).toBe(true);
    expect(needsAsking({ checkedAt: "2026-10-21T09:55:00Z", reason: "source_unreadable" }, "2026-10-10T09:00:00Z", now)).toBe(false);
  });
});
