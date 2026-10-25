import { describe, expect, it } from "vitest";
import { isStateTooLong, withFittingText } from "../../src/lib/qualification-judge.js";

const tooLong = () =>
  new Error('[lead-service] chat-service judgment failed: 400 {"error":"TypeSafe refused the request","judge":"jev","detail":"{\\"detail\\":{\\"error_type\\":\\"max_tokens_exceeded\\"}}","retryable":false}');

describe("withFittingText", () => {
  it("asks again on the first half until the judge accepts it", async () => {
    const seen: number[] = [];
    const out = await withFittingText("x".repeat(100_000), async (t) => {
      seen.push(t.length);
      if (t.length > 30_000) throw tooLong();
      return "ok";
    });
    expect(out).toBe("ok");
    expect(seen).toEqual([100_000, 50_000, 25_000]);
  });

  it("never retries another failure", async () => {
    let calls = 0;
    await expect(withFittingText("x".repeat(10_000), async () => { calls++; throw new Error("chat-service judgment failed: 502"); })).rejects.toThrow("502");
    expect(calls).toBe(1);
  });

  it("stops after its shrink budget and throws the refusal", async () => {
    let calls = 0;
    await expect(withFittingText("x".repeat(100_000), async () => { calls++; throw tooLong(); }, 2)).rejects.toThrow("max_tokens_exceeded");
    expect(calls).toBe(3);
  });

  it("recognises only the token-limit refusal", () => {
    expect(isStateTooLong(tooLong())).toBe(true);
    expect(isStateTooLong(new Error("invalid Unicode text"))).toBe(false);
    expect(isStateTooLong("max_tokens_exceeded")).toBe(false);
  });
});
