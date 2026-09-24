import { describe, expect, it } from "vitest";
import {
  decodeFeedPosition,
  encodeFeedPosition,
  FeedPositionError,
} from "../../src/lib/lead-change-feed.js";

describe("a change-feed position", () => {
  const feedId = "3f1c2b8e-9a4d-4c55-8e1a-0b2c3d4e5f60";

  it("round-trips the feed and the version", () => {
    const raw = encodeFeedPosition({ feedId, version: "123456789012" });
    expect(raw.startsWith("lf1.")).toBe(true);
    expect(decodeFeedPosition(raw)).toEqual({ feedId, version: "123456789012" });
  });

  it("refuses anything it did not issue — a caller error, never a silent reset", () => {
    const bad = [
      "",
      "nonsense",
      "lf1.",
      "lf1." + Buffer.from(`${feedId}`).toString("base64url"),
      "lf1." + Buffer.from(`not-a-uuid:1`).toString("base64url"),
      "lf1." + Buffer.from(`${feedId}:-1`).toString("base64url"),
      "lf1." + Buffer.from(`${feedId}:1:2`).toString("base64url"),
      "lf1." + Buffer.from(`${feedId}:1e3`).toString("base64url"),
    ];
    for (const raw of bad) expect(() => decodeFeedPosition(raw), raw).toThrow(FeedPositionError);
  });
});
