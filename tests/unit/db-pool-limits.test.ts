import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * The pool ceiling and the two per-session timeouts are stated in code, not inherited.
 *
 * postgres.js defaults to `max: 10`. That default was the reason ten abandoned reads on
 * 2026-09-07 took lead-service down completely: the tenth wedged connection was the last one.
 * The timeouts ride in the startup packet, so they bind lead-service's own sessions and nothing
 * else on the shared Postgres.
 */

const OLD_ENV = { ...process.env };

async function loadDb() {
  vi.resetModules();
  return await import("../../src/db/index.js");
}

beforeEach(() => {
  process.env.LEAD_SERVICE_DATABASE_URL = "postgres://user:pass@localhost:5432/lead_test";
  delete process.env.LEAD_DB_POOL_MAX;
  delete process.env.LEAD_DB_STATEMENT_TIMEOUT_MS;
  delete process.env.LEAD_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS;
});

afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe("database pool limits", () => {
  it("states its own ceiling instead of taking postgres.js's default of 10", async () => {
    const db = await loadDb();

    expect(db.POOL_MAX).toBe(20);
    expect(db.POOL_OPTIONS.max).toBe(20);
  });

  it("bounds how long one connection may run a statement or sit in a transaction", async () => {
    const db = await loadDb();

    expect(db.STATEMENT_TIMEOUT_MS).toBe(120_000);
    expect(db.IDLE_IN_TRANSACTION_TIMEOUT_MS).toBe(120_000);
    // Sent as startup parameters: per SESSION, so no shared server setting is touched.
    expect(db.POOL_OPTIONS.connection).toEqual({
      statement_timeout: 120_000,
      idle_in_transaction_session_timeout: 120_000,
      jit: "off",
    });
  });

  it("takes an operator override from the environment", async () => {
    process.env.LEAD_DB_POOL_MAX = "35";
    process.env.LEAD_DB_STATEMENT_TIMEOUT_MS = "45000";
    const db = await loadDb();

    expect(db.POOL_MAX).toBe(35);
    expect(db.STATEMENT_TIMEOUT_MS).toBe(45_000);
  });

  it("refuses an unreadable override rather than falling back to a default nobody chose", async () => {
    process.env.LEAD_DB_POOL_MAX = "none";

    await expect(loadDb()).rejects.toThrow(/LEAD_DB_POOL_MAX must be a positive number/);
  });
});
