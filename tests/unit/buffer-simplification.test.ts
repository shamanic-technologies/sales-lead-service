import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const bufferSrc = readFileSync(
  join(__dirname, "..", "..", "src", "lib", "buffer.ts"),
  "utf-8",
);

describe("buffer.ts simplification invariants", () => {
  it("no longer uses FOR UPDATE SKIP LOCKED — campaign-service serializes per campaign", () => {
    expect(bufferSrc).not.toMatch(/SKIP LOCKED/);
    expect(bufferSrc).not.toMatch(/FOR UPDATE/);
  });

  it("no longer runs the 1h stale-claimed recovery — try/finally release covers it", () => {
    expect(bufferSrc).not.toMatch(/recoverStaleClaims/);
    expect(bufferSrc).not.toMatch(/stale claimed/i);
  });

  it("releases the claim back to 'buffered' on exception via try/finally", () => {
    expect(bufferSrc).toMatch(/finally\s*\{[\s\S]*claimSettled[\s\S]*status:\s*"buffered"/);
  });

  it("wraps peopleSearch in try/catch and routes provider validation errors back into the strategy loop", () => {
    expect(bufferSrc).toMatch(/try\s*\{[\s\S]*peopleSearch[\s\S]*\}\s*catch/);
    expect(bufferSrc).toMatch(/advanceStrategyOrGenerate[\s\S]*lastSearchError/);
  });
});
