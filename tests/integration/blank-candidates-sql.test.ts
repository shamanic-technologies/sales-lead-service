/**
 * BLANK-CANDIDATES-1101: a blank candidate's sighting is logged with its id and counted where the Monitoring hub reads
 * it (the `blank-candidates` box check), against a REAL database.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { blankCandidates } from "../../src/db/schema.js";
import { blankCandidatesCheckRun, measureBlankCandidates, noteBlankCandidate } from "../../src/lib/blank-candidates.js";

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("blank candidates against a real database", () => {
  const candidateId = randomUUID();
  const audienceId = `aud-${randomUUID()}`;

  afterAll(async () => {
    await db.delete(blankCandidates).where(eq(blankCandidates.candidateId, candidateId));
  });

  it("logs the candidate id, records each sighting once per candidate, and turns the Monitoring check red", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = {
      candidateId,
      audienceId,
      providerPersonId: "p-1",
      linkedinUrl: null,
      offeredAt: "2026-11-01T00:00:00Z",
      person: { name: null, title: null, headline: null, seniority: null, city: null, state: null, country: null },
      company: { name: null, domain: "wellsetdenver.com", industry: null, employees: null, city: null, state: null, country: null, keywords: null },
    };
    await noteBlankCandidate(c, { orgId: "org-1", brandId: "brand-1", runId: "run-1" });
    await noteBlankCandidate(c, { orgId: "org-1", brandId: "brand-1", runId: "run-2" });
    expect(errors.mock.calls.some((args) => String(args[0]).includes(`candidate=${candidateId}`))).toBe(true);
    errors.mockRestore();

    const [row] = await db.select().from(blankCandidates).where(eq(blankCandidates.candidateId, candidateId));
    expect(row.seenCount).toBe(2);
    expect(row.runId).toBe("run-2");

    const measure = await measureBlankCandidates();
    expect(measure.lastWindow).toBeGreaterThanOrEqual(1);
    expect(measure.byAudience.find((a) => a.audienceId === audienceId)).toMatchObject({ candidates: 1, exampleCandidateIds: [candidateId] });
    const run = blankCandidatesCheckRun(measure, new Date());
    expect(run).toMatchObject({ check: "blank-candidates", ok: false });
  });
});
