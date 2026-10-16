import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { acceptedVerdicts, emailPolicyClause, normalizeEmailPolicy, readEmailVerdict } from "../../src/lib/email-policy.js";
import { serveBody } from "../../src/lib/people-client.js";
import { BufferNextRequestSchema } from "../../src/schemas.js";

const dialect = new PgDialect();

describe("email policy (CATCHALL-SERVE-OPTION-1013)", () => {
  it("absent = valid only; catch-all only when asked; never unknown/invalid/risky", () => {
    expect(acceptedVerdicts(undefined)).toEqual(["valid"]);
    expect(acceptedVerdicts("valid_only")).toEqual(["valid"]);
    expect(acceptedVerdicts("valid_and_catch_all")).toEqual(["valid", "catch_all"]);
    // CATCHALL-BOUNCE-1016: the deprecated value accepts exactly what valid_and_catch_all accepts.
    expect(acceptedVerdicts("valid_catch_all_and_unknown")).toEqual(["valid", "catch_all"]);
  });

  it("normalizes the deprecated value to valid_and_catch_all, leaves the others alone (CATCHALL-BOUNCE-1016)", () => {
    expect(normalizeEmailPolicy("valid_catch_all_and_unknown")).toBe("valid_and_catch_all");
    expect(normalizeEmailPolicy("valid_and_catch_all")).toBe("valid_and_catch_all");
    expect(normalizeEmailPolicy("valid_only")).toBe("valid_only");
    expect(normalizeEmailPolicy(undefined)).toBeNull();
    expect(normalizeEmailPolicy(null)).toBeNull();
  });

  it("the pool clause refuses a recorded verdict outside the policy and keeps NULL", () => {
    const q = dialect.sqlToQuery(emailPolicyClause(sql`lc.lead_id`, undefined));
    expect(q.sql).toContain("verification_verdict IS NOT NULL AND cm_v.verification_verdict NOT IN ($1)");
    expect(q.params).toEqual(["valid"]);
    const wide = dialect.sqlToQuery(emailPolicyClause(sql`lc.lead_id`, "valid_and_catch_all"));
    expect(wide.params).toEqual(["valid", "catch_all"]);
    const legacy = dialect.sqlToQuery(emailPolicyClause(sql`lc.lead_id`, "valid_catch_all_and_unknown"));
    expect(legacy.params).toEqual(["valid", "catch_all"]);
  });

  it("as_found (a stock pipe stating nothing) keeps the source's choice but never an address no pipe may email", () => {
    const q = dialect.sqlToQuery(emailPolicyClause(sql`lc.lead_id`, "as_found"));
    expect(q.sql).toContain("cm_v.verification_verdict IN ($1, $2, $3)");
    expect(q.params).toEqual(["unknown", "invalid", "risky"]);
  });

  it("serve body: no option = today's bytes; option rides beside reachableBy", () => {
    expect(serveBody({ orgId: "o" })).toEqual({});
    expect(serveBody({ orgId: "o", reachableBy: ["email"] })).toEqual({ reachableBy: ["email"] });
    expect(serveBody({ orgId: "o", acceptedEmails: "valid_and_catch_all" })).toEqual({ acceptedEmails: "valid_and_catch_all" });
  });

  it("buffer/next body: empty stays valid, the two values parse, anything else is a 400", () => {
    expect(BufferNextRequestSchema.safeParse({}).success).toBe(true);
    expect(BufferNextRequestSchema.safeParse({ acceptedEmails: "valid_only" }).success).toBe(true);
    expect(BufferNextRequestSchema.safeParse({ acceptedEmails: "valid_and_catch_all" }).success).toBe(true);
    expect(BufferNextRequestSchema.safeParse({ acceptedEmails: "valid_catch_all_and_unknown" }).success).toBe(true);
    expect(BufferNextRequestSchema.safeParse({ acceptedEmails: "unknown" }).success).toBe(false);
    expect(BufferNextRequestSchema.safeParse({ acceptedEmails: "valid_catch_all_unknown_and_invalid" }).success).toBe(false);
  });

  it("reads a verdict as stated, null when absent, fails loud on garbage", () => {
    expect(readEmailVerdict(undefined)).toBeNull();
    expect(readEmailVerdict(null)).toBeNull();
    expect(readEmailVerdict("catch_all")).toBe("catch_all");
    expect(() => readEmailVerdict(42)).toThrow();
  });
});
