import { describe, it, expect } from "vitest";

describe("postgres.js array types under drizzle-orm >= 0.41", () => {
  it("leaves date[] / timestamptz[] / timestamp[] / numeric[] to postgres.js (no drizzle pass-through)", async () => {
    process.env.LEAD_SERVICE_DATABASE_URL ??= "postgres://test:test@localhost:5432/lead_service_test";
    const { sql } = await import("../../src/db/index.js");
    const options = sql.options as unknown as {
      parsers: Record<string, unknown>;
      serializers: Record<string, unknown>;
    };
    for (const oid of ["1182", "1185", "1115", "1231"]) {
      expect(options.parsers[oid]).toBeUndefined();
      expect(options.serializers[oid]).toBeUndefined();
    }
    // The scalar overrides drizzle relies on stay in place.
    expect(options.parsers["1184"]).toBeTypeOf("function");
  });
});
