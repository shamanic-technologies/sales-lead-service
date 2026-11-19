import { describe, it, expect } from "vitest";
import { overdue, RED_AFTER_MS } from "../../src/lib/awaiting-answer-watch.js";

const now = Date.parse("2026-11-18T12:00:00Z");
const person = (waitingSince: string) => ({
  leadId: "l", email: "drcampbell@arcticchiropractic.com", name: "Walter Campbell", waitingSince,
  lastMessage: { at: waitingSince, kind: "question" },
});

describe("awaiting-answer watch (REPLY-NO-BALANCE-1118)", () => {
  it("a person waiting past the hour counts, one under the hour does not", () => {
    expect(overdue([person(new Date(now - RED_AFTER_MS - 1000).toISOString())], now)).toHaveLength(1);
    expect(overdue([person(new Date(now - 30 * 60_000).toISOString())], now)).toHaveLength(0);
  });
  it("Doc Dinners: a doctor waiting 7 days counts, a wait older than 30 days does not", () => {
    const r = overdue([person("2026-11-11T02:09:28Z"), person("2026-07-16T13:11:40Z")], now);
    expect(r.map((p) => p.waitingSince)).toEqual(["2026-11-11T02:09:28Z"]);
    expect(r[0]).toMatchObject({ email: "drcampbell@arcticchiropractic.com", lastMessageKind: "question" });
  });
});
