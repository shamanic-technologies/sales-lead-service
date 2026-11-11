/**
 * `unibox_reached_steps(steps)` (migration 0145, MON-PAGE-SPEED-1111) keeps exactly the rows the `reachedStep=` filter
 * kept before it: `EXISTS (SELECT 1 FROM jsonb_array_elements(steps) s WHERE s->>'step' = ANY(list))`.
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("unibox_reached_steps", () => {
  it("keeps the same rows as the jsonb walk, for every shape of steps", async () => {
    const samples = [
      [{ step: "website_visit", at: "2026-11-01T00:00:00Z" }, { step: "email_sent", at: null }],
      [{ step: "email_sent" }],
      [{ at: "2026-11-01T00:00:00Z" }, { step: null }],
      [],
    ];
    for (const list of [["website_visit"], ["email_sent", "website_visit"], ["meeting_booked"]]) {
      for (const steps of samples) {
        const rows = (await db.execute(sql`
          SELECT
            COALESCE(EXISTS (SELECT 1 FROM jsonb_array_elements(${JSON.stringify(steps)}::jsonb) s WHERE s->>'step' = ANY(${sql.param(list)}::text[])), false) AS before,
            COALESCE(unibox_reached_steps(${JSON.stringify(steps)}::jsonb) && ${sql.param(list)}::text[], false) AS after
        `)) as unknown as Array<{ before: boolean; after: boolean }>;
        expect({ steps, list, kept: rows[0].after }).toEqual({ steps, list, kept: rows[0].before });
      }
    }
  });
});
