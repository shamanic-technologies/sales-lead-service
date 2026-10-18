/**
 * LIVE-RESEARCH-1018: the fleet screen read (src/lib/candidate-screening-stats.ts) against a REAL database.
 * Scoped to this suite's own orgs: every other suite writes candidate_screenings in the same database.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { candidateScreenings } from "../../src/db/schema.js";
import { readCandidateScreeningStats } from "../../src/lib/candidate-screening-stats.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("candidate screening stats against a real database", () => {
  const orgA = randomUUID();
  const orgB = randomUUID();

  afterAll(async () => {
    await db.delete(candidateScreenings).where(inArray(candidateScreenings.orgId, [orgA, orgB]));
  });

  it("buckets P(yes) on the pass bar's edges, splits months in UTC, counts distinct reach", async () => {
    const row = (orgId: string, audienceId: string, p: number | null, verdict: string, at: string) => ({
      orgId,
      brandId: `brand-${orgId}`,
      audienceId,
      providerPersonId: randomUUID(),
      candidateId: randomUUID(),
      targetHash: "h",
      promptVersion: "v1",
      verdict,
      yesProbability: p,
      createdAt: new Date(at),
    });
    await db.insert(candidateScreenings).values([
      row(orgA, "aud-1", 0.1, "reject", "2026-10-07T10:00:00Z"),
      row(orgA, "aud-1", 0.2, "reject", "2026-10-08T10:00:00Z"),
      row(orgA, "aud-2", 0.5, "reject", "2026-10-31T23:59:59Z"),
      row(orgB, "aud-3", 0.51, "pass", "2026-11-01T00:00:00Z"),
      row(orgB, "aud-3", 0.8, "pass", "2026-11-02T00:00:00Z"),
      row(orgB, "aud-3", null, "reject", "2026-11-03T00:00:00Z"),
    ]);

    const stats = await readCandidateScreeningStats({ orgIds: [orgA, orgB] });
    expect(stats.distinct).toEqual({ orgs: 2, brands: 2, audiences: 3 });
    expect(stats.firstScreenedAt).toBe("2026-10-07T10:00:00.000Z");
    expect(stats.lastScreenedAt).toBe("2026-11-03T00:00:00.000Z");
    expect(stats.totals).toMatchObject({ screened: 6, passed: 2, declined: 4 });
    expect(stats.totals.byProbability).toEqual({
      below_0_2: { screened: 1, passed: 0, declined: 1 },
      from_0_2_to_0_5: { screened: 2, passed: 0, declined: 2 },
      above_0_5_below_0_8: { screened: 1, passed: 1, declined: 0 },
      from_0_8: { screened: 1, passed: 1, declined: 0 },
      unscored: { screened: 1, passed: 0, declined: 1 },
    });
    expect(stats.months.map((m) => [m.month, m.screened])).toEqual([
      ["2026-10", 3],
      ["2026-11", 3],
    ]);
  });
});
