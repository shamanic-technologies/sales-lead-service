import { describe, it, expect, vi } from "vitest";

// @sentry/node 9+ (we run 10) accepts only a boolean for registerEsmLoaderHooks
// and wraps only the modules it instruments.
describe("Sentry instrument (@sentry/node 10)", () => {
  it("initializes Sentry with the v10 option shape when SENTRY_DSN is set", async () => {
    vi.resetModules();
    const init = vi.fn();
    const setTag = vi.fn();
    vi.doMock("@sentry/node", () => ({ init, setTag }));
    const prev = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    try {
      await import("../../src/instrument.js");
    } finally {
      if (prev === undefined) delete process.env.SENTRY_DSN;
      else process.env.SENTRY_DSN = prev;
      vi.doUnmock("@sentry/node");
    }
    expect(init).toHaveBeenCalledTimes(1);
    const opts = init.mock.calls[0][0];
    expect(opts.dsn).toBe("https://public@example.ingest.sentry.io/1");
    expect(opts.registerEsmLoaderHooks === undefined || typeof opts.registerEsmLoaderHooks === "boolean").toBe(true);
    expect(setTag).toHaveBeenCalledWith("service", "lead-service");
  });
});
