import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: { execute: async () => [] }, sql: Object.assign(() => [], { param: (x: unknown) => x }) }));

const fetchWithRetry = vi.fn();
vi.mock("../../src/lib/fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => fetchWithRetry(...a) }));

const { loadLifecycleCatalogue, readLifecycleCatalogue, resetLifecycleCatalogueCache } = await import("../../src/lib/unibox-model.js");

function answer(label: string) {
  return { ok: true, status: 200, json: async () => ({ lifecycleLadder: [{ key: "engaged", rank: 3, label }], rows: [{ key: "conversation", lifecycleRank: 3 }] }) };
}

describe("lifecycle catalogue held for page reads (MON-PAGE-SPEED-1114)", () => {
  beforeEach(() => {
    resetLifecycleCatalogueCache();
    fetchWithRetry.mockReset();
    vi.useFakeTimers({ toFake: ["Date"] });
  });
  afterEach(() => vi.useRealTimers());

  it("a read past the TTL is served the held catalogue at once and the next read gets the refreshed one", async () => {
    fetchWithRetry.mockResolvedValueOnce(answer("Engaged v1"));
    expect((await readLifecycleCatalogue()).ladder[0].label).toBe("Engaged v1");
    vi.setSystemTime(Date.now() + 6 * 60_000);
    let release!: (v: unknown) => void;
    fetchWithRetry.mockReturnValueOnce(new Promise((r) => (release = r)));
    // features-service has not answered yet: the read does not wait on it.
    expect((await readLifecycleCatalogue()).ladder[0].label).toBe("Engaged v1");
    // A second read during the refresh starts no second fetch.
    expect((await readLifecycleCatalogue()).ladder[0].label).toBe("Engaged v1");
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);
    release(answer("Engaged v2"));
    await vi.waitFor(async () => expect((await readLifecycleCatalogue()).ladder[0].label).toBe("Engaged v2"));
  });

  it("a failed refresh keeps the held catalogue for reads", async () => {
    fetchWithRetry.mockResolvedValueOnce(answer("Engaged v1"));
    await readLifecycleCatalogue();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchWithRetry.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    expect((await readLifecycleCatalogue()).ladder[0].label).toBe("Engaged v1");
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    errors.mockRestore();
  });

  it("with nothing held a read waits and fails loud", async () => {
    fetchWithRetry.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(readLifecycleCatalogue()).rejects.toThrow(/503/);
  });

  it("the row refresh never runs on a held catalogue: past the TTL it waits and fails loud", async () => {
    fetchWithRetry.mockResolvedValueOnce(answer("Engaged v1"));
    await loadLifecycleCatalogue();
    vi.setSystemTime(Date.now() + 6 * 60_000);
    fetchWithRetry.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await expect(loadLifecycleCatalogue()).rejects.toThrow(/503/);
  });
});
