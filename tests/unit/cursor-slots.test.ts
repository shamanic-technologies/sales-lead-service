import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CURSOR_SLOTS, cursorSlotState, withCursorSlot } from "../../src/lib/cursor-slots.js";
import { POOL_MAX } from "../../src/db/pool-size.js";

/**
 * A cursor walk holds a pool connection for the whole walk and reads more on other connections between chunks: with as
 * many walks as connections, nothing moves (DASH-SPEED-1110-LEAD-R3). Walks take a slot, at most half the pool.
 */
describe("cursor slots", () => {
  it("leaves at least half the pool to everything else", () => {
    expect(CURSOR_SLOTS).toBeGreaterThanOrEqual(1);
    expect(CURSOR_SLOTS * 2).toBeLessThanOrEqual(Math.max(2, POOL_MAX));
  });

  it("holds the walks past the slots, hands each freed slot on, and frees one on an early stop", async () => {
    const gates: Array<() => void> = [];
    const opened: number[] = [];
    const walk = (i: number) =>
      withCursorSlot(async function* () {
        opened.push(i);
        await new Promise<void>((r) => gates.push(r));
        yield i;
        yield i + 1000;
      });
    const n = CURSOR_SLOTS + 2;
    const runs = Array.from({ length: n }, (_, i) =>
      (async () => {
        const out: number[] = [];
        for await (const v of walk(i)) {
          out.push(v);
          if (i === 0) break; // an early stop gives its slot back too
        }
        return out;
      })(),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(opened).toHaveLength(CURSOR_SLOTS);
    expect(cursorSlotState()).toMatchObject({ inUse: CURSOR_SLOTS, waiting: 2 });
    while (gates.length > 0 || opened.length < n) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 1));
    }
    const results = await Promise.all(runs);
    expect(results[0]).toEqual([0]);
    expect(results[1]).toEqual([1, 1001]);
    expect(cursorSlotState()).toMatchObject({ inUse: 0, waiting: 0 });
  });

  it("gives the slot back when the walk throws", async () => {
    const failing = withCursorSlot(async function* () {
      yield 1;
      throw new Error("boom");
    });
    await expect((async () => { for await (const _ of failing) void _; })()).rejects.toThrow("boom");
    expect(cursorSlotState().inUse).toBe(0);
  });

  it("every server-side cursor in src walks behind a slot", () => {
    const files: string[] = [];
    const walkDir = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walkDir(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walkDir(join(__dirname, "../../src"));
    const bare: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (/\.cursor\(/.test(line) && !/^\s*(\*|\/\/)/.test(line) && !line.includes("withCursorSlot(")) bare.push(`${f}:${i + 1}`);
      });
    }
    expect(bare).toEqual([]);
  });
});
