import { describe, it, expect, vi, beforeEach } from "vitest";

const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
const insertValues = vi.fn(() => ({ onConflictDoUpdate }));

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({ values: (...a: unknown[]) => insertValues(...a) }),
  },
}));

describe("upsertContactMethod", () => {
  beforeEach(() => {
    insertValues.mockClear();
    onConflictDoUpdate.mockClear();
  });

  it("uses onConflictDoUpdate so re-enrichment overwrites stale status (e.g. unverified -> verified)", async () => {
    const { upsertContactMethod } = await import("../../src/lib/leads-registry.js");

    await upsertContactMethod({
      leadId: "lead-1",
      channel: "email",
      value: "x@y.com",
      status: "verified",
      source: "apollo",
    });

    expect(insertValues).toHaveBeenCalledOnce();
    expect(insertValues.mock.calls[0][0]).toMatchObject({
      leadId: "lead-1",
      channel: "email",
      value: "x@y.com",
      status: "verified",
      source: "apollo",
    });
    expect(onConflictDoUpdate).toHaveBeenCalledOnce();
    const setArg = onConflictDoUpdate.mock.calls[0][0] as { set: { status: string; source: string } };
    expect(setArg.set.status).toBe("verified");
    expect(setArg.set.source).toBe("apollo");
  });
});
