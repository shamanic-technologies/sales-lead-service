import { describe, expect, it } from "vitest";
import {
  decideChannelOccurrence,
  decideEmailOccurrence,
  isWritable,
  readEnrichOutput,
} from "../../src/lib/named-lead-serve.js";

const clean = { contacted: false, sent: false, queued: false, finished: false, refusal: null, sentCount: 0 };

describe("decideEmailOccurrence (LEAD-NAMED-SERVE-1015)", () => {
  it("a new occurrence of a person the sender holds nothing for is handed out", () => {
    expect(decideEmailOccurrence(clean, null)).toBeNull();
  });

  it("the sender's silence is a wait, never a guess", () => {
    expect(decideEmailOccurrence(null, null)).toMatchObject({ reason: "named_lead_sender_unreadable", final: false });
  });

  it("a redelivered occurrence whose earlier run sent is refused for good", () => {
    const baseline = { sentCount: 0, contacted: false, firstServedAt: "2026-10-15T10:00:00.000Z" };
    expect(decideEmailOccurrence({ ...clean, sent: true, contacted: true, sentCount: 1 }, baseline)).toMatchObject({
      reason: "named_lead_already_worked",
      final: true,
    });
    // Queued by the earlier run: it will be sent, never handed out twice.
    expect(decideEmailOccurrence({ ...clean, queued: true }, baseline)).toMatchObject({ reason: "named_lead_already_worked" });
    expect(decideEmailOccurrence({ ...clean, contacted: true }, baseline)).toMatchObject({ reason: "named_lead_already_worked" });
  });

  it("a redelivered occurrence whose earlier run failed before sending gets the person again", () => {
    const baseline = { sentCount: 0, contacted: false, firstServedAt: "2026-10-15T10:00:00.000Z" };
    expect(decideEmailOccurrence(clean, baseline)).toBeNull();
  });

  it("a person emailed under an EARLIER occurrence is not 'already worked' for a new one", () => {
    const earlier = { ...clean, sent: true, contacted: true, sentCount: 2 };
    expect(decideEmailOccurrence(earlier, null)).toBeNull();
    // Same occurrence redelivered with nothing new since its first hand-out: served again.
    expect(decideEmailOccurrence(earlier, { sentCount: 2, contacted: true, firstServedAt: "2026-10-15T10:00:00.000Z" })).toBeNull();
  });

  it("sender refusal, finished, and a new occurrence of a queued person are final", () => {
    expect(decideEmailOccurrence({ ...clean, refusal: { code: "recent_brand_contact", until: "2026-12-01T00:00:00Z" } }, null)).toMatchObject({
      reason: "named_lead_sender_refuses",
      final: true,
      message: expect.stringContaining("2026-12-01"),
    });
    expect(decideEmailOccurrence({ ...clean, finished: true }, null)).toMatchObject({ reason: "named_lead_sender_finished", final: true });
    expect(decideEmailOccurrence({ ...clean, queued: true }, null)).toMatchObject({ reason: "named_lead_in_send_queue", final: true });
  });
});

describe("decideChannelOccurrence", () => {
  const C = "camp-1";
  const send = (status: string, createdAt: string, campaignId = C) => ({ sendId: `s-${createdAt}`, status, campaignId, sentAt: null, createdAt });
  it("a send of this campaign since the first hand-out = already worked; before it = served again", () => {
    const baseline = { sentCount: null, contacted: null, firstServedAt: "2026-10-15T10:00:00.000Z" };
    expect(decideChannelOccurrence([send("sent", "2026-10-15T10:05:00Z")], C, baseline)).toMatchObject({ reason: "named_lead_already_worked" });
    expect(decideChannelOccurrence([send("sent", "2026-10-01T10:05:00Z")], C, baseline)).toBeNull();
    expect(decideChannelOccurrence([send("failed", "2026-10-15T10:05:00Z")], C, baseline)).toBeNull();
    expect(decideChannelOccurrence([send("sent", "2026-10-15T10:05:00Z", "other")], C, baseline)).toBeNull();
  });
  it("a new occurrence while a send is in flight = in the queue", () => {
    expect(decideChannelOccurrence([send("sending", "2026-10-15T10:05:00Z")], C, null)).toMatchObject({ reason: "named_lead_in_send_queue" });
    expect(decideChannelOccurrence(undefined, C, null)).toBeNull();
  });
});

describe("isWritable / readEnrichOutput", () => {
  it("a first name or a company is enough; an email alone is not", () => {
    expect(isWritable({ firstName: "Ann", companyName: null })).toBe(true);
    expect(isWritable({ firstName: null, companyName: "Acme" })).toBe(true);
    expect(isWritable({ firstName: " ", companyName: null })).toBe(false);
  });

  it("reads treg's normalized output (shape measured 2026-10-15)", () => {
    const r = readEnrichOutput({
      output: { full_name: "Bill Gates", first_name: "Bill", last_name: "Gates", title: "Co-chair", company: "Gates Foundation", company_domain: "gatesfoundation.org", linkedin_url: "williamhgates", location: "Seattle" },
    });
    expect(r).toEqual({
      found: true,
      firstName: "Bill",
      lastName: "Gates",
      fullName: "Bill Gates",
      title: "Co-chair",
      companyName: "Gates Foundation",
      companyDomain: "gatesfoundation.org",
      linkedinUrl: "https://www.linkedin.com/in/williamhgates",
    });
  });

  it("a miss finds nobody; a full name alone is split", () => {
    expect(readEnrichOutput({ output: {} }).found).toBe(false);
    expect(readEnrichOutput(null).found).toBe(false);
    expect(readEnrichOutput({ output: { full_name: "Jane van Dyke" } })).toMatchObject({ firstName: "Jane", lastName: "van Dyke" });
  });
});
