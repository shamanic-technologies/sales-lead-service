import { describe, it, expect } from "vitest";
import { prefetchOne } from "../../src/lib/prefetch.js";

function source(n: number, log: string[], failAt?: number) {
  let closed = false;
  const gen = (async function* () {
    try {
      for (let i = 0; i < n; i += 1) {
        log.push(`pull ${i}`);
        if (i === failAt) throw new Error(`boom ${i}`);
        yield i;
      }
    } finally {
      closed = true;
      log.push("closed");
    }
  })();
  return { gen, isClosed: () => closed };
}

describe("prefetchOne", () => {
  it("yields every item, in order, and reads exactly one ahead", async () => {
    const log: string[] = [];
    const { gen, isClosed } = source(3, log);
    const seen: number[] = [];
    for await (const v of prefetchOne(gen)) {
      log.push(`use ${v}`);
      seen.push(v);
    }
    expect(seen).toEqual([0, 1, 2]);
    // item 1 is pulled BEFORE item 0 is used — that is the overlap.
    expect(log.indexOf("pull 1")).toBeLessThan(log.indexOf("use 0"));
    expect(log.indexOf("pull 2")).toBeGreaterThan(log.indexOf("use 0"));
    expect(isClosed()).toBe(true);
  });

  it("closes the source when the consumer stops early", async () => {
    const log: string[] = [];
    const { gen, isClosed } = source(10, log);
    for await (const v of prefetchOne(gen)) {
      if (v === 1) break;
    }
    expect(isClosed()).toBe(true);
  });

  it("closes the source when the consumer throws", async () => {
    const log: string[] = [];
    const { gen, isClosed } = source(10, log);
    await expect(
      (async () => {
        for await (const v of prefetchOne(gen)) if (v === 0) throw new Error("client gone");
      })(),
    ).rejects.toThrow("client gone");
    expect(isClosed()).toBe(true);
  });

  it("surfaces a source failure at the consumer, never swallowing it", async () => {
    const log: string[] = [];
    const { gen } = source(5, log, 2);
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const v of prefetchOne(gen)) seen.push(v);
      })(),
    ).rejects.toThrow("boom 2");
    expect(seen).toEqual([0, 1]);
  });
});
