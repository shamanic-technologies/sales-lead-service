import { describe, it, expect, vi, beforeEach } from "vitest";

describe("config", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("exports all required env vars when they are set", async () => {
    const config = await import("../../src/config.js");

    expect(config.HUMAN_SERVICE_URL).toBe(process.env.HUMAN_SERVICE_URL);
    expect(config.HUMAN_SERVICE_API_KEY).toBe(process.env.HUMAN_SERVICE_API_KEY);
    expect(config.BRAND_SERVICE_URL).toBe(process.env.BRAND_SERVICE_URL);
    expect(config.EMAIL_GATEWAY_SERVICE_URL).toBe(process.env.EMAIL_GATEWAY_SERVICE_URL);
    expect(config.RUNS_SERVICE_URL).toBe(process.env.RUNS_SERVICE_URL);
    expect(config.KEY_SERVICE_URL).toBe(process.env.KEY_SERVICE_URL);
    expect(config.LEAD_SERVICE_API_KEY).toBe(process.env.LEAD_SERVICE_API_KEY);
  });

  it("throws when a required env var is missing", async () => {
    const original = process.env.HUMAN_SERVICE_URL;
    delete process.env.HUMAN_SERVICE_URL;

    try {
      await expect(
        import("../../src/config.js")
      ).rejects.toThrow("Missing required environment variable: HUMAN_SERVICE_URL");
    } finally {
      process.env.HUMAN_SERVICE_URL = original;
    }
  });

  it("throws when a required env var is empty string", async () => {
    const original = process.env.HUMAN_SERVICE_API_KEY;
    process.env.HUMAN_SERVICE_API_KEY = "";

    try {
      await expect(
        import("../../src/config.js")
      ).rejects.toThrow("Missing required environment variable: HUMAN_SERVICE_API_KEY");
    } finally {
      process.env.HUMAN_SERVICE_API_KEY = original;
    }
  });

  it("PULL_NEXT_TIMEOUT_MS is at least 600_000 to accommodate multi-round Pro strategy generation", async () => {
    const config = await import("../../src/config.js");
    expect(config.PULL_NEXT_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
  });
});
