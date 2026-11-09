import { describe, expect, it } from "vitest";
import { otherWritersOf, participantsOf, threadKeyOf, writerRowId } from "../../src/lib/message-participants.js";
import { isCopiedSend } from "../../src/lib/crm-act-types.js";

describe("message participants (EVERY-PERSON-ON-THE-THREAD-1109)", () => {
  it("reads every stated address with its role, lower-cased and deduped; skips unreadable entries", () => {
    expect(
      participantsOf({
        participants: [
          { email: "Markus@Markthalle.ch", role: "from" },
          { email: "markus@markthalle.ch", role: "from" },
          { email: "kevin@mailbox.test", role: "to" },
          { email: "thomas@markthalle.ch", role: "cc" },
          { email: "x@y.z", role: "reply-to" },
          { email: 42, role: "bcc" },
        ],
      }),
    ).toEqual([
      { email: "markus@markthalle.ch", role: "from" },
      { email: "kevin@mailbox.test", role: "to" },
      { email: "thomas@markthalle.ch", role: "cc" },
    ]);
  });

  it("falls back to reply.fromEmail on a fact copied before `participants`", () => {
    expect(participantsOf({ reply: { fromEmail: "Markus@markthalle.ch" } })).toEqual([{ email: "markus@markthalle.ch", role: "from" }]);
    expect(participantsOf({ reply: { fromEmail: null } })).toEqual([]);
  });

  it("another writer = a `from` of a reply other than the thread's lead and our mailbox; our sends have none", () => {
    const raw = { participants: [{ email: "markus@m.ch", role: "from" }, { email: "kevin@mailbox.test", role: "to" }] };
    expect(otherWritersOf("reply", raw, "Thomas@m.ch")).toEqual(["markus@m.ch"]);
    expect(otherWritersOf("reply", { participants: [{ email: "thomas@m.ch", role: "from" }] }, "THOMAS@m.ch")).toEqual([]);
    expect(otherWritersOf("reply", { participants: [{ email: "kevin@mailbox.test", role: "from" }], reply: { accountEmail: "kevin@mailbox.test" } }, "t@m.ch")).toEqual([]);
    expect(otherWritersOf("email_sent", { participants: [{ email: "x@m.ch", role: "from" }] }, "t@m.ch")).toEqual([]);
  });

  it("names the writer row and reads the thread key", () => {
    expect(writerRowId("reply:r1", "L2")).toBe("reply:r1#writer:L2");
    expect(threadKeyOf({ threadKey: "<a@b>" })).toBe("<a@b>");
    expect(threadKeyOf({})).toBeNull();
  });

  it("a send of ours on which a person is only copied (cc/bcc) is not a send to them", () => {
    expect(isCopiedSend("message_out", { role: "cc" })).toBe(true);
    expect(isCopiedSend("message_out", { role: "bcc" })).toBe(true);
    expect(isCopiedSend("message_out", { role: "to" })).toBe(false);
    expect(isCopiedSend("message_out", {})).toBe(false);
    expect(isCopiedSend("message_in", { role: "cc" })).toBe(false);
  });
});
