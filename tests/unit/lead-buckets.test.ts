import { describe, it, expect } from "vitest";
import {
  LEAD_BUCKETS,
  bucketsForRow,
  isDelivered,
  isSent,
  leadActivityAt,
  outcomeBucketsAreStepOutcomes,
  parseLeadBucket,
  zeroBucketCounts,
} from "../../src/lib/lead-buckets.js";
import { DEFAULT_STATUS, type FlattenedStatus } from "../../src/lib/delivery-flatten.js";
import type { LeadStepOutcomeName } from "../../src/lib/step-statements.js";

function delivery(overrides: Partial<FlattenedStatus>): FlattenedStatus {
  return { ...DEFAULT_STATUS, ...overrides };
}

const none = new Set<LeadStepOutcomeName>();

describe("the bucket vocabulary", () => {
  it("names a bucket or refuses — never silently drops the filter", () => {
    expect(parseLeadBucket(undefined)).toBeNull();
    expect(parseLeadBucket("sale")).toBe("sale");
    expect(() => parseLeadBucket("everyone")).toThrow(/Unknown bucket/);
    expect(() => parseLeadBucket("")).toThrow(/Unknown bucket/);
  });

  it("counts every bucket, so a bucket nobody is in reads as 0 rather than as absent", () => {
    const counts = zeroBucketCounts();
    expect(Object.keys(counts).sort()).toEqual([...LEAD_BUCKETS].sort());
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });

  it("keeps its outcome half inside the outcome vocabulary", () => {
    expect(outcomeBucketsAreStepOutcomes()).toBe(true);
  });
});

describe("which buckets a row is in", () => {
  it("puts nobody anywhere on a row with no evidence at all", () => {
    expect([...bucketsForRow(DEFAULT_STATUS, none)]).toEqual([]);
    expect([...bucketsForRow(null, none)]).toEqual([]);
  });

  it("reads a contacted person as contacted", () => {
    expect([...bucketsForRow(delivery({ contacted: true }), none)]).toEqual(["contacted"]);
  });

  it("counts a measured click and a hand-stated visit as ONE person, not two", () => {
    const measured = bucketsForRow(delivery({ clicked: true }), none);
    const stated = bucketsForRow(DEFAULT_STATUS, new Set<LeadStepOutcomeName>(["website_visit"]));
    const both = bucketsForRow(delivery({ clicked: true }), new Set<LeadStepOutcomeName>(["website_visit"]));
    expect(measured.has("website_visit")).toBe(true);
    expect(stated.has("website_visit")).toBe(true);
    expect([...both]).toEqual(["website_visit"]);
  });

  it("only calls a reply positive when the provider classified it positive", () => {
    expect(
      bucketsForRow(delivery({ replied: true, replyClassification: "negative" }), none).has(
        "positive_reply",
      ),
    ).toBe(false);
    expect(
      bucketsForRow(delivery({ replied: true, replyClassification: "positive" }), none).has(
        "positive_reply",
      ),
    ).toBe(true);
  });

  it("is not a partition — somebody who bought was also contacted", () => {
    const buckets = bucketsForRow(
      delivery({ contacted: true, clicked: true }),
      new Set<LeadStepOutcomeName>(["sale"]),
    );
    expect([...buckets].sort()).toEqual(["contacted", "sale", "website_visit"]);
  });
});

describe("when a lead last got as far as it has got", () => {
  const served = "2026-01-02T00:00:00.000Z";
  const created = "2026-01-01T00:00:00.000Z";

  it("dates a lead by its most advanced status, down the funnel", () => {
    const full = delivery({
      firstSentAt: "2026-02-01T00:00:00.000Z",
      firstOpenedAt: "2026-02-02T00:00:00.000Z",
      firstClickedAt: "2026-02-03T00:00:00.000Z",
      firstRepliedAt: "2026-02-04T00:00:00.000Z",
    });
    expect(leadActivityAt(full, "2026-03-01T00:00:00.000Z", served, created)).toBe(
      "2026-03-01T00:00:00.000Z",
    );
    expect(leadActivityAt(full, null, served, created)).toBe("2026-02-04T00:00:00.000Z");
    expect(leadActivityAt({ ...full, firstRepliedAt: null }, null, served, created)).toBe(
      "2026-02-03T00:00:00.000Z",
    );
    expect(
      leadActivityAt({ ...full, firstRepliedAt: null, firstClickedAt: null }, null, served, created),
    ).toBe("2026-02-02T00:00:00.000Z");
  });

  it("falls back to the serve, then to the row itself — never to null", () => {
    expect(leadActivityAt(DEFAULT_STATUS, null, served, created)).toBe(served);
    expect(leadActivityAt(null, null, null, created)).toBe(created);
  });
});

describe("whether a person was sent an email, and whether it was delivered", () => {
  it("is sent only when an email actually left — contacted (queued in a sequence) is not sent", () => {
    expect(isSent(null)).toBe(false);
    expect(isSent(DEFAULT_STATUS)).toBe(false);
    expect(isSent(delivery({ contacted: true }))).toBe(false);
    expect(isSent(delivery({ contacted: true, sent: true }))).toBe(true);
  });

  it("is delivered when sent and not bounced at this scope — a subset of sent", () => {
    expect(isDelivered(null)).toBe(false);
    expect(isDelivered(DEFAULT_STATUS)).toBe(false);
    // Queued, nothing sent: nobody can have bounced, and nothing was delivered either.
    expect(isDelivered(delivery({ contacted: true }))).toBe(false);
    expect(isDelivered(delivery({ contacted: true, sent: true }))).toBe(true);
    expect(isDelivered(delivery({ contacted: true, sent: true, bounced: true }))).toBe(false);
    // Another brand's bounce says nothing about whether OUR email arrived.
    expect(
      isDelivered(delivery({ contacted: true, sent: true, global: { bounced: true, unsubscribed: false } })),
    ).toBe(true);
    expect(isDelivered(delivery({ bounced: true }))).toBe(false);
  });
});

describe("booking_call bucket", () => {
  it("is a bucket key, filled only by a placed booking call, never by an outcome", () => {
    expect(LEAD_BUCKETS).toContain("booking_call");
    expect(bucketsForRow(DEFAULT_STATUS, new Set(), false, true).has("booking_call")).toBe(true);
    expect(bucketsForRow(DEFAULT_STATUS, new Set<LeadStepOutcomeName>(["meeting_booked"]), true, false).has("booking_call")).toBe(false);
  });
});
