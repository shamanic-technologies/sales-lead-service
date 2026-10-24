/**
 * COST-SUPPORT-1024-LEAD against a REAL database: a past qualification PREVIEW run declares `company_researched` for the
 * companies it paid NEW research for (a charged observation or a verdict it recorded), never for what it reused.
 * runs-service's batch door is faked. Every read is scoped to this file's org.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { qualificationCriteria, qualificationObservations, qualificationVerdicts, qualificationPreviews } = await import("../../src/db/schema.js");
const { loadPastPreviewResearch, loadPastSampleResearch, runOutcomeBackfill } = await import("../../src/lib/run-outcome-backfill.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("preview research backfill against a real database", () => {
  const orgId = `itest-rop-${randomUUID()}`;
  const tag = randomUUID().slice(0, 8);
  const dom = (name: string) => `${name}-${tag}.example`;
  const observationIds: string[] = [];

  async function observation(domain: string, runId: string | null, vendorCostMicro: number): Promise<string> {
    const [o] = await db
      .insert(qualificationObservations)
      .values({ probeKey: `itest:${tag}`, domain, status: "ok", content: "x", vendorCostMicro, runId })
      .returning({ id: qualificationObservations.id });
    observationIds.push(o.id);
    return o.id;
  }

  async function preview(runId: string | null, domains: string[]): Promise<void> {
    await db.insert(qualificationPreviews).values({
      orgId,
      brandId: randomUUID(),
      offerId: randomUUID(),
      companies: domains.map((domain) => ({ domain, name: domain })),
      criterionIds: [],
      runId,
      status: "completed",
    });
  }

  afterAll(async () => {
    if (observationIds.length > 0) {
      await db.execute(sql`DELETE FROM qualification_verdicts WHERE observation_id = ANY(${sql.param(observationIds)}::uuid[])`);
      await db.execute(sql`DELETE FROM qualification_observations WHERE id = ANY(${sql.param(observationIds)}::uuid[])`);
    }
    await db.execute(sql`DELETE FROM qualification_previews WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM qualification_criteria WHERE org_id = ${orgId}`);
  });

  it("declares each company a preview run paid new research for, on that run", async () => {
    const paid = randomUUID();
    const reusedOnly = randomUUID();
    // `paid`: a charged probe on a, a free reading + new verdict on b, a free reading alone on c (nothing new paid).
    await observation(dom("a"), paid, 1500);
    const freeB = await observation(dom("b"), paid, 0);
    await db.insert(qualificationVerdicts).values({ criterionKey: `itest:${tag}`, domain: dom("b"), observationId: freeB, verdict: "yes", runId: paid });
    await observation(dom("c"), paid, 0);
    await preview(paid, [dom("a"), dom("b"), dom("c")]);
    // `reusedOnly`: read verdicts another run paid for; recorded nothing of its own.
    const earlier = await observation(dom("d"), randomUUID(), 900);
    await db.insert(qualificationVerdicts).values({ criterionKey: `itest:${tag}`, domain: dom("d"), observationId: earlier, verdict: "no", runId: randomUUID() });
    await preview(reusedOnly, [dom("d")]);
    await preview(null, [dom("e")]);

    const runs = await loadPastPreviewResearch({ orgId });
    expect(runs).toEqual([
      {
        runId: paid,
        orgId,
        produced: [dom("a"), dom("b")].map((subjectId) => ({ outcomeKey: "company_researched", subjectService: "lead-service", subjectId })),
        consumed: [],
      },
    ]);

    const posted: unknown[] = [];
    const report = await runOutcomeBackfill(
      { dryRun: false },
      { post: async (b) => (posted.push(b), { status: 201, json: { recordedCount: 2 }, text: "" }), lookup: async () => [], scope: { orgId } },
    );
    expect(report.previewResearch).toEqual({ runs: 1, companies: 2 });
    expect(posted).toEqual([
      {
        runs: [
          {
            runId: paid,
            produced: [dom("a"), dom("b")].map((subjectId) => ({ outcomeKey: "company_researched", subjectService: "lead-service", subjectId })),
            occurredAt: "run_started_at",
            redate: true,
          },
        ],
      },
    ]);
  });

  it("LEDGER-HISTORY-1024: a past SAMPLE run (named by runs-service) declares the companies it paid new research for", async () => {
    const sample = randomUUID();
    const otherTask = randomUUID();
    await db.insert(qualificationCriteria).values({ orgId, brandId: randomUUID(), offerId: randomUUID(), question: "q", probe: {}, mode: "mention" });
    await observation(dom("s1"), sample, 700);
    await observation(dom("s2"), sample, 0);
    await observation(dom("s3"), otherTask, 900);
    const asked: Array<[string, string]> = [];
    const listRuns = async (o: string, task: string) => (asked.push([o, task]), [sample.toUpperCase()].map((x) => x.toLowerCase()));
    const runs = await loadPastSampleResearch({ orgId }, listRuns);
    expect(asked).toEqual([[orgId, "qualification-sample"]]);
    expect(runs).toEqual([
      { runId: sample, orgId, produced: [{ outcomeKey: "company_researched", subjectService: "lead-service", subjectId: dom("s1") }], consumed: [] },
    ]);
  });
});
