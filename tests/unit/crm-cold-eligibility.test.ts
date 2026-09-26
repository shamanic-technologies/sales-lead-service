import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
const fetchCrmConnection = vi.fn();
const fetchCrmStageMeanings = vi.fn();

vi.mock("../../src/db/index.js", () => ({ db: { execute: (...a: unknown[]) => execute(...a) } }));
vi.mock("../../src/lib/crm-client.js", () => ({
  fetchCrmConnection: (...a: unknown[]) => fetchCrmConnection(...a),
  fetchCrmStageMeanings: (...a: unknown[]) => fetchCrmStageMeanings(...a),
}));

const { loadCrmColdEligibility, clearCrmColdEligibilityCache, CRM_SYNC_MAX_AGE_MS } = await import(
  "../../src/lib/crm-cold-eligibility.js"
);

const NOW = new Date("2026-09-26T14:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

function connection(over: Record<string, unknown>) {
  return {
    id: "c1",
    brandId: "b1",
    locationId: "l1",
    status: "active",
    synced: true,
    lastSyncedAt: minutesAgo(10),
    lastError: null,
    ...over,
  };
}

beforeEach(() => {
  clearCrmColdEligibilityCache();
  execute.mockReset().mockResolvedValue([{ hit: 1 }]);
  fetchCrmConnection.mockReset();
  fetchCrmStageMeanings.mockReset().mockResolvedValue([
    { pipelineId: "p", stageId: "s", stageName: "Booked", meaning: "meeting_booked", servedAsEvidence: true },
  ]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("loadCrmColdEligibility — judged on the last SUCCESSFUL sync", () => {
  it("applies on a healthy, fresh connection", async () => {
    fetchCrmConnection.mockResolvedValue(connection({}));
    const e = await loadCrmColdEligibility("o1", "b1", NOW);
    expect(e).toMatchObject({ eligible: true, reason: null, evidences: { meeting_booked: true } });
  });

  it("still applies when the last attempt failed but the last good sync is recent (transient)", async () => {
    // Doc Dinners, 2026-09-26: one `/calendars/events aborted after 20000ms`, data 31 min old.
    fetchCrmConnection.mockResolvedValue(
      connection({ status: "error", lastError: "GET /calendars/events aborted after 20000ms", lastSyncedAt: minutesAgo(31) }),
    );
    const e = await loadCrmColdEligibility("o1", "b1", NOW);
    expect(e).toMatchObject({ eligible: true, reason: null });
  });

  it("does not apply when nothing succeeded inside the window and the sync is failing", async () => {
    fetchCrmConnection.mockResolvedValue(
      connection({ status: "error", lastError: "401 invalid token", lastSyncedAt: minutesAgo(CRM_SYNC_MAX_AGE_MS / 60_000 + 1) }),
    );
    const e = await loadCrmColdEligibility("o1", "b1", NOW);
    expect(e).toMatchObject({ eligible: false, reason: "crm_sync_failing" });
    expect(fetchCrmStageMeanings).not.toHaveBeenCalled();
  });

  it("does not apply when the data is stale even with no recorded error", async () => {
    fetchCrmConnection.mockResolvedValue(connection({ lastSyncedAt: minutesAgo(CRM_SYNC_MAX_AGE_MS / 60_000 + 1) }));
    const e = await loadCrmColdEligibility("o1", "b1", NOW);
    expect(e).toMatchObject({ eligible: false, reason: "crm_sync_stale" });
  });

  it("does not apply when the connection is paused (disconnected by the customer)", async () => {
    fetchCrmConnection.mockResolvedValue(connection({ status: "paused" }));
    const e = await loadCrmColdEligibility("o1", "b1", NOW);
    expect(e).toMatchObject({ eligible: false, reason: "crm_not_active" });
  });

  it("does not apply when the brand has no CRM connection", async () => {
    fetchCrmConnection.mockResolvedValue(null);
    const e = await loadCrmColdEligibility("o1", "b1", NOW);
    expect(e).toMatchObject({ eligible: false, reason: "no_crm_connection" });
  });

  it("does not apply when a failing connection never synced successfully", async () => {
    fetchCrmConnection.mockResolvedValue(connection({ status: "error", lastError: "boom", synced: false, lastSyncedAt: null }));
    const e = await loadCrmColdEligibility("o1", "b1", NOW);
    expect(e).toMatchObject({ eligible: false, reason: "crm_not_synced" });
  });

  it("does not apply to a brand without a CRM pairing, with no network call", async () => {
    execute.mockResolvedValue([]);
    const e = await loadCrmColdEligibility("o1", "b1", NOW);
    expect(e).toMatchObject({ eligible: false, reason: "crm_never_paired" });
    expect(fetchCrmConnection).not.toHaveBeenCalled();
  });
});
