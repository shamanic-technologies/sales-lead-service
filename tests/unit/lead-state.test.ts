import { describe, expect, it } from "vitest";
import { leadStateOf, leadVerdictOf, topRungRank } from "../../src/lib/lead-state.js";
import { lifecycleOfClient } from "../../src/lib/unibox-dimensions.js";

const ladder = [
  { key: "lead_found", rank: 1, label: "Lead found" },
  { key: "contacted", rank: 2, label: "Contacted" },
  { key: "engaged", rank: 3, label: "Engaged" },
  { key: "paid_client", rank: 7, label: "Paid client" },
];
const base = { lifecycleRank: 2, reachable: "contactable", fit: "fit", interest: "not_asked" } as const;

describe("ONE lead vocabulary (LEAD-GENERIC-1106)", () => {
  it("won = the ladder's top rung, whatever the catalogue calls it", () => {
    expect(topRungRank(ladder)).toBe(7);
    expect(leadVerdictOf({ ...base, lifecycleRank: 7 }, 7)).toEqual({ won: true, hot: false, lost: null });
    // A won lead who unsubscribed is still won, never lost.
    expect(leadVerdictOf({ ...base, lifecycleRank: 7, reachable: "unsubscribed", interest: "not_interested" }, 7).lost).toBeNull();
    expect(leadVerdictOf({ ...base, lifecycleRank: null }, null).won).toBe(false);
  });

  it("lost names every reason, strongest first", () => {
    expect(leadVerdictOf({ ...base, reachable: "bounced", fit: "not_our_target", interest: "not_interested" }, 7).lost).toEqual({
      reasons: ["not_reachable", "wrong_fit", "not_interested"],
      reachable: "bounced",
      fit: "not_our_target",
    });
    expect(leadVerdictOf({ ...base, interest: "not_interested" }, 7).lost).toEqual({ reasons: ["not_interested"], reachable: null, fit: null });
  });

  it("hot = interested, not won, not lost; the three never overlap", () => {
    expect(leadVerdictOf({ ...base, interest: "interested" }, 7)).toEqual({ won: false, hot: true, lost: null });
    expect(leadVerdictOf({ ...base, interest: "interested", reachable: "do_not_contact" }, 7).hot).toBe(false);
    expect(leadVerdictOf({ ...base, interest: "unsure" }, 7)).toEqual({ won: false, hot: false, lost: null });
  });

  it("the state carries the row's dimensions and the lead's next follow-up", () => {
    const row = {
      lifecycle: ladder[2],
      contactability: "contactable",
      conversation: "waiting_on_us",
      fit: "fit",
      fitNote: null,
      interest: "interested",
      status: "prospect",
    } as const;
    expect(leadStateOf(row, ladder, { at: "2026-12-01T09:00:00.000Z", basis: "stated" })).toEqual({
      lifecycle: ladder[2],
      won: false,
      hot: true,
      lost: null,
      reachable: "contactable",
      conversation: "waiting_on_us",
      fit: "fit",
      fitNote: null,
      interest: "interested",
      clientStatus: "prospect",
      nextFollowupAt: "2026-12-01T09:00:00.000Z",
      nextFollowupBasis: "stated",
    });
    expect(leadStateOf(row, ladder, null)).toMatchObject({ nextFollowupAt: null, nextFollowupBasis: null });
  });

  it("a client (customer or churned) stands on the top rung; a prospect keeps its outcomes' rung", () => {
    expect(lifecycleOfClient(ladder[2], "customer", ladder)).toEqual(ladder[3]);
    expect(lifecycleOfClient(null, "churned", ladder)).toEqual(ladder[3]);
    expect(lifecycleOfClient(ladder[2], "prospect", ladder)).toEqual(ladder[2]);
    expect(lifecycleOfClient(null, "prospect", ladder)).toBeNull();
  });
});
