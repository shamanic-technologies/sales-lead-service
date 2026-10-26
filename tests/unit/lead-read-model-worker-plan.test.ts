import { describe, it, expect } from "vitest";
import type { ReadModelScope } from "../../src/lib/lead-read-model.js";

const { planSweep, REFRESH_IF_READ_WITHIN_MS, IDLE_PINNED_REFRESH_AFTER_MS } = await import(
  "../../src/lib/lead-read-model-worker.js"
);

const NOW = Date.parse("2026-10-14T14:00:00Z");
const MIN = 60_000;
const scope = (id: string) => ({ orgId: id }) as unknown as ReadModelScope;
const model = (key: string, readMinutesAgo: number) => ({
  scope_key: key,
  scope: scope(key),
  last_read_at: new Date(NOW - readMinutesAgo * MIN).toISOString(),
});

describe("planSweep (DB-LOAD-1014)", () => {
  it("refreshes a model read within the window, leaves an idle one alone, retires one unread for 7 days", () => {
    const { refresh, retire } = planSweep(
      [model("hot", 2), model("edge", REFRESH_IF_READ_WITHIN_MS / MIN), model("idle", 6 * 60), model("dead", 8 * 24 * 60)],
      new Map(),
      NOW,
    );
    expect([...refresh.keys()].sort()).toEqual(["edge", "hot"]);
    expect(retire).toEqual(["dead"]);
  });

  it("always refreshes a pinned active-brand model, read or not, and never retires it", () => {
    const pinned = new Map([
      ["brand-a", scope("brand-a")],
      ["brand-b", scope("brand-b")],
    ]);
    const { refresh, retire } = planSweep([model("brand-a", 8 * 24 * 60)], pinned, NOW);
    expect([...refresh.keys()].sort()).toEqual(["brand-a", "brand-b"]);
    expect(retire).toEqual([]);
  });

  it("refreshes an IDLE pinned model only once its evidence is 30 min old; a read one keeps the 3-min cadence (BOX-OVERLOAD-1026)", () => {
    const pinned = new Map([
      ["idle-fresh", scope("idle-fresh")],
      ["idle-old", scope("idle-old")],
      ["read-fresh", scope("read-fresh")],
      ["not-built", scope("not-built")],
    ]);
    const at = (minutesAgo: number) => new Date(NOW - minutesAgo * MIN).toISOString();
    const { refresh, retire } = planSweep(
      [
        { ...model("idle-fresh", 3 * 60), evidence_at: at(IDLE_PINNED_REFRESH_AFTER_MS / MIN - 1) },
        { ...model("idle-old", 3 * 60), evidence_at: at(IDLE_PINNED_REFRESH_AFTER_MS / MIN + 1) },
        { ...model("read-fresh", 5), evidence_at: at(4) },
      ],
      pinned,
      NOW,
    );
    expect([...refresh.keys()].sort()).toEqual(["idle-old", "not-built", "read-fresh"]);
    expect(retire).toEqual([]);
  });
});
