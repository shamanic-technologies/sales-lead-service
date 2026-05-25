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
    onConflictDoUpdate.mockResolvedValue(undefined);
  });

  it("returns { inserted: true } on happy path and targets (leadId, channel, value)", async () => {
    const { upsertContactMethod } = await import("../../src/lib/leads-registry.js");

    const result = await upsertContactMethod({
      leadId: "lead-1",
      channel: "email",
      value: "x@y.com",
      status: "verified",
      source: "apollo",
    });

    expect(result).toEqual({ inserted: true });
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

  it("returns { inserted: false, reason: 'global_collision' } when (channel, value) already belongs to another lead", async () => {
    const dupErr = Object.assign(
      new Error('duplicate key value violates unique constraint "idx_lcm_channel_value"'),
      { code: "23505", constraint_name: "idx_lcm_channel_value" },
    );
    onConflictDoUpdate.mockRejectedValueOnce(dupErr);

    const { upsertContactMethod } = await import("../../src/lib/leads-registry.js");

    const result = await upsertContactMethod({
      leadId: "lead-2",
      channel: "email",
      value: "shared@x.com",
      status: "verified",
      source: "apollo",
    });

    expect(result).toEqual({ inserted: false, reason: "global_collision" });
  });

  it("rethrows non-dup Postgres errors (e.g. serialization failures)", async () => {
    const serializationErr = Object.assign(new Error("could not serialize"), { code: "40001" });
    onConflictDoUpdate.mockRejectedValueOnce(serializationErr);

    const { upsertContactMethod } = await import("../../src/lib/leads-registry.js");

    await expect(
      upsertContactMethod({
        leadId: "lead-3",
        channel: "email",
        value: "z@y.com",
        status: null,
        source: "apollo",
      }),
    ).rejects.toThrow("could not serialize");
  });

  it("rethrows 23505 on other constraints (only swallows the global (channel, value) collision)", async () => {
    const wrongConstraintErr = Object.assign(
      new Error('duplicate key value violates unique constraint "idx_lcm_lead_channel_value"'),
      { code: "23505", constraint_name: "idx_lcm_lead_channel_value" },
    );
    onConflictDoUpdate.mockRejectedValueOnce(wrongConstraintErr);

    const { upsertContactMethod } = await import("../../src/lib/leads-registry.js");

    await expect(
      upsertContactMethod({
        leadId: "lead-4",
        channel: "email",
        value: "q@y.com",
        status: "verified",
        source: "apollo",
      }),
    ).rejects.toThrow("idx_lcm_lead_channel_value");
  });
});
