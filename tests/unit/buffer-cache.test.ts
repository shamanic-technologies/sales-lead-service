import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import {
  hasValidEmail,
  isCacheFresh,
  CACHE_TTL_MS,
  VALID_EMAIL_STATUSES,
} from "../../src/lib/buffer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bufferSrc = readFileSync(
  join(__dirname, "..", "..", "src", "lib", "buffer.ts"),
  "utf-8",
);

describe("hasValidEmail", () => {
  it("returns true for verified email", () => {
    expect(hasValidEmail("a@b.com", "verified")).toBe(true);
  });

  it("returns true for extrapolated email", () => {
    expect(hasValidEmail("a@b.com", "extrapolated")).toBe(true);
  });

  it("returns false for unverified status", () => {
    expect(hasValidEmail("a@b.com", "unverified")).toBe(false);
  });

  it("returns false for guessed status", () => {
    expect(hasValidEmail("a@b.com", "guessed")).toBe(false);
  });

  it("returns false when email is null", () => {
    expect(hasValidEmail(null, "verified")).toBe(false);
  });

  it("returns false when status is null", () => {
    expect(hasValidEmail("a@b.com", null)).toBe(false);
  });

  it("returns false when both null", () => {
    expect(hasValidEmail(null, null)).toBe(false);
  });

  it("returns false for empty string email", () => {
    expect(hasValidEmail("", "verified")).toBe(false);
  });
});

describe("isCacheFresh", () => {
  it("returns false when enrichedAt is null", () => {
    expect(isCacheFresh(null)).toBe(false);
  });

  it("returns true for enrichedAt within TTL", () => {
    const recent = new Date(Date.now() - 1_000);
    expect(isCacheFresh(recent)).toBe(true);
  });

  it("returns true for enrichedAt 23h ago", () => {
    const recent = new Date(Date.now() - 23 * 60 * 60 * 1000);
    expect(isCacheFresh(recent)).toBe(true);
  });

  it("returns false for enrichedAt 25h ago", () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    expect(isCacheFresh(stale)).toBe(false);
  });

  it("returns false for enrichedAt at exactly TTL boundary", () => {
    const boundary = new Date(Date.now() - CACHE_TTL_MS);
    expect(isCacheFresh(boundary)).toBe(false);
  });
});

describe("CACHE_TTL_MS", () => {
  it("is 24 hours", () => {
    expect(CACHE_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("VALID_EMAIL_STATUSES", () => {
  it("contains exactly verified and extrapolated", () => {
    expect(VALID_EMAIL_STATUSES).toEqual(new Set(["verified", "extrapolated"]));
  });
});

describe("buffer.ts source invariants", () => {
  it("does not reference dead constant CACHE_TTL_EMAIL_FOUND_MS", () => {
    expect(bufferSrc).not.toMatch(/CACHE_TTL_EMAIL_FOUND_MS/);
  });

  it("does not reference dead constant CACHE_TTL_NO_EMAIL_MS", () => {
    expect(bufferSrc).not.toMatch(/CACHE_TTL_NO_EMAIL_MS/);
  });

  it("uses single CACHE_TTL_MS constant", () => {
    expect(bufferSrc).toMatch(/CACHE_TTL_MS/);
  });

  it("gates enrichment on hasValidEmail rather than raw email presence", () => {
    expect(bufferSrc).toMatch(/hasValidEmail/);
  });
});
