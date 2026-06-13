import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchWithRetry } from "../../src/lib/fetch-retry.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function socketError(): Error {
  // Mirrors the real undici shape: TypeError("fetch failed") with a cause
  // carrying the transient code (UND_ERR_SOCKET "other side closed").
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a transient UND_ERR_SOCKET rejection and resolves", async () => {
    const ok = { ok: true, status: 200 } as Response;
    mockFetch
      .mockRejectedValueOnce(socketError())
      .mockRejectedValueOnce(socketError())
      .mockResolvedValueOnce(ok);

    const p = fetchWithRetry("http://x/y");
    const assertion = expect(p).resolves.toBe(ok);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("retries when the transient code is nested under cause", async () => {
    const ok = { ok: true, status: 200 } as Response;
    const nested = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }),
    });
    mockFetch.mockRejectedValueOnce(nested).mockResolvedValueOnce(ok);

    const p = fetchWithRetry("http://x/y");
    const assertion = expect(p).resolves.toBe(ok);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("retries when the transient code is inside an AggregateError.errors", async () => {
    const ok = { ok: true, status: 200 } as Response;
    const agg = Object.assign(new AggregateError([
      Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
    ], "fetch failed"));
    mockFetch.mockRejectedValueOnce(agg).mockResolvedValueOnce(ok);

    const p = fetchWithRetry("http://x/y");
    const assertion = expect(p).resolves.toBe(ok);
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a completed HTTP 500 response (it's a real answer)", async () => {
    const res500 = { ok: false, status: 500 } as Response;
    mockFetch.mockResolvedValueOnce(res500);

    // No retry path → no timers to advance.
    await expect(fetchWithRetry("http://x/y")).resolves.toBe(res500);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a non-transient rejection and propagates it", async () => {
    const plain = new Error("boom");
    mockFetch.mockRejectedValueOnce(plain);

    // No retry path → no timers to advance.
    await expect(fetchWithRetry("http://x/y")).rejects.toBe(plain);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting retries on a persistently transient error", async () => {
    mockFetch.mockRejectedValue(socketError());

    const p = fetchWithRetry("http://x/y");
    const assertion = expect(p).rejects.toThrow("fetch failed");
    await vi.runAllTimersAsync();
    await assertion;
    // 1 initial attempt + 3 backoff retries.
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});
