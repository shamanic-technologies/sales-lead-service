import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockExecute, mockWrite } = vi.hoisted(() => ({ mockExecute: vi.fn(), mockWrite: vi.fn() }));
vi.mock("../../src/db/index.js", () => ({ db: { execute: mockExecute } }));
vi.mock("../../src/lib/followup-queue.js", () => ({ writeFollowupStatement: mockWrite }));

import { wakeClientStatedDates } from "../../src/lib/client-date-wake.js";

// CLIENT-DATE-WAKE-1030: Olive's check-in stated 19:30 UTC "later" on Client WhatsApp; nothing came back at the date.
describe("wakeClientStatedDates", () => {
  beforeEach(() => vi.clearAllMocks());

  it("makes the stating campaign's row due at the stated date, as that campaign", async () => {
    mockExecute.mockResolvedValue([
      { id: "baab553e", org_id: "org-1", next_followup_at: "2026-10-29 19:30:00+00", stated_by_campaign_id: "camp-client-wa" },
    ]);
    mockWrite.mockResolvedValue({});
    expect(await wakeClientStatedDates(Date.parse("2026-10-30T06:30:00Z"))).toEqual({ woken: 1, failed: 0 });
    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-1",
        id: "baab553e",
        kind: "scheduled",
        dueAtIso: "2026-10-29T19:30:00.000Z",
        reason: null,
        actingCampaignId: "camp-client-wa",
      }),
    );
  });

  it("selects clients only, once per date, never a handed or already-due row", async () => {
    mockExecute.mockResolvedValue([]);
    await wakeClientStatedDates();
    const query = JSON.stringify(mockExecute.mock.calls[0][0]);
    for (const clause of [
      "d.basis = 'stated'",
      "lc.campaign_id = d.stated_by_campaign_id",
      "lc.followup_handed_at IS NULL",
      "lc.followup_due_at IS NULL",
      "lc.updated_at < d.next_followup_at",
      "conversion_events",
      "attribution_status = 'attributed'",
    ]) {
      expect(query).toContain(clause);
    }
  });

  it("one row failing never stops the others", async () => {
    mockExecute.mockResolvedValue([
      { id: "a", org_id: "o", next_followup_at: "2026-10-29T19:30:00Z", stated_by_campaign_id: "c" },
      { id: "b", org_id: "o", next_followup_at: "2026-10-29T19:31:00Z", stated_by_campaign_id: "c" },
    ]);
    mockWrite.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await wakeClientStatedDates()).toEqual({ woken: 1, failed: 1 });
    err.mockRestore();
  });
});
