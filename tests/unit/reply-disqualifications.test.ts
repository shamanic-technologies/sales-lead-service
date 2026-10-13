import { describe, expect, it } from "vitest";
import { replyDisqualifications, type TimelineFactRow } from "../../src/lib/timeline-facts.js";

// A reply judged "not the right contact" / "left the role" sets the Disqualified MARK on its
// conversation, the earliest such reply being the reason; every other reply sets nothing.
function reply(id: string, label: TimelineFactRow["label"], at: string, over: Partial<TimelineFactRow> = {}): TimelineFactRow {
  return {
    id, org_id: "o", brand_id: "b", offer_id: "offer-1", lead_id: "lead-1", campaign_id: "c", occurred_at: at,
    label, source: "reply", source_ref: `ref-${id}`, attributable: true, attribution_basis: "reaction_to_our_email",
    url: null, detail: {}, withdrawn_at: null, ...over,
  };
}

describe("replyDisqualifications", () => {
  it("marks wrong-contact and changed-job replies, earliest first, with a note in the reply's terms", () => {
    const marks = replyDisqualifications([
      reply("a", "interested", "2026-10-01T00:00:00.000Z"),
      reply("b", "changed_job", "2026-10-03T00:00:00.000Z"),
      reply("c", "wrong_contact", "2026-10-02T00:00:00.000Z"),
      reply("d", "not_interested", "2026-10-04T00:00:00.000Z"),
      reply("e", "paid_client", "2026-10-05T00:00:00.000Z"),
    ]);
    expect(marks).toEqual([
      { leadId: "lead-1", offerId: "offer-1", replyRef: "ref-c", note: "Their reply says they are not the right contact." },
      { leadId: "lead-1", offerId: "offer-1", replyRef: "ref-b", note: "Their reply says they left the role." },
    ]);
  });

  it("ignores a withdrawn reply and anything that is not a reply", () => {
    expect(
      replyDisqualifications([
        reply("a", "wrong_contact", "2026-10-01T00:00:00.000Z", { withdrawn_at: "2026-10-02T00:00:00.000Z" }),
        reply("b", "wrong_contact", "2026-10-01T00:00:00.000Z", { source: "outreach" }),
      ]),
    ).toEqual([]);
  });
});
