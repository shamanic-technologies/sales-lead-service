/**
 * The re-contact windows a serve may state (FRESH-CONTACTS-1015, FRESH-2-MONTHS-1027, FRESH-NEVER-1106): the two dated
 * windows keep their bound byte for byte, `never` has none (any date), and nothing else is accepted.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { BufferNextRequestSchema } from "../../src/schemas.js";
import { emailedWithin, RECENTLY_EMAILED_WINDOWS } from "../../src/lib/recently-emailed-sql.js";

const dialect = new PgDialect();
const compiled = (window: (typeof RECENTLY_EMAILED_WINDOWS)[number]) =>
  dialect.sqlToQuery(emailedWithin(sql`l.id`, { window, brandIds: ["b1"] })).sql;

describe("re-contact windows", () => {
  it("the body accepts exactly 3_months, 2_months and never", () => {
    for (const w of ["3_months", "2_months", "never"]) {
      expect(BufferNextRequestSchema.safeParse({ excludeEmailedWithin: w }).success).toBe(true);
    }
    for (const w of ["1_month", "ever", "", "NEVER"]) {
      expect(BufferNextRequestSchema.safeParse({ excludeEmailedWithin: w }).success).toBe(false);
    }
  });

  it("3_months and 2_months keep their calendar bound; never reads every send, any date", () => {
    expect(compiled("3_months")).toContain("f_re.occurred_at > now() - interval '3 months'");
    expect(compiled("2_months")).toContain("f_re.occurred_at > now() - interval '2 months'");
    expect(compiled("never")).not.toContain("occurred_at");
    expect(compiled("never")).toContain("f_re.type = 'email_sent'");
  });
});
