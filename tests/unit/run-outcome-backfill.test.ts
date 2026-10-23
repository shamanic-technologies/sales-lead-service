/**
 * COST-BACKFILL-1023-LEAD: the pure half of the past-outcomes backfill (src/lib/run-outcome-backfill.ts).
 *   - one declaration per past run, the live `lead_found` rule (subject = lead, email_checked consumed when checked);
 *   - batches within the door's limits;
 *   - a re-pointed find is credited only to the ONE lead-serve child whose window holds it;
 *   - a refused run is set aside with its reason, the rest re-sent; anything else throws (re-run resumes).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));

const { groupFindsByRun, chunkBackfillRuns, findingChild, declareBackfillBatch, resolveRepointedFinds, BATCH_MAX_RUNS, BATCH_MAX_OCCURRENCES } = await import(
  "../../src/lib/run-outcome-backfill.js"
);

const RUN_A = "aaaaaaaa-0000-4000-8000-000000000001";
const RUN_B = "bbbbbbbb-0000-4000-8000-000000000002";

describe("groupFindsByRun", () => {
  it("declares lead_found per lead on its finding run, the email check consumed only when one was recorded", () => {
    const runs = groupFindsByRun([
      { source: "direct", runId: RUN_B, orgId: "org", leadId: "lead-2", emailChecked: false },
      { source: "direct", runId: RUN_A.toUpperCase(), orgId: "org", leadId: "lead-1", emailChecked: true },
      { source: "repointed", runId: RUN_A, orgId: "org", leadId: "lead-1", emailChecked: false },
    ]);
    expect(runs).toEqual([
      {
        runId: RUN_A,
        orgId: "org",
        produced: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "lead-1" }],
        consumed: [{ outcomeKey: "email_checked", subjectService: "lead-service", subjectId: "lead-1" }],
      },
      { runId: RUN_B, orgId: "org", produced: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "lead-2" }], consumed: [] },
    ]);
  });

  it("refuses a run named under two orgs", () => {
    expect(() =>
      groupFindsByRun([
        { source: "direct", runId: RUN_A, orgId: "org-1", leadId: "l1", emailChecked: false },
        { source: "archived", runId: RUN_A, orgId: "org-2", leadId: "l2", emailChecked: false },
      ]),
    ).toThrow(/two orgs/);
  });
});

describe("chunkBackfillRuns", () => {
  const run = (i: number, n: number) => ({
    runId: `run-${String(i).padStart(5, "0")}`,
    orgId: "org",
    produced: Array.from({ length: n }, (_, k) => ({ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: `l${i}-${k}` })),
    consumed: [],
  });

  it("caps runs per batch", () => {
    const batches = chunkBackfillRuns(Array.from({ length: BATCH_MAX_RUNS * 2 + 1 }, (_, i) => run(i, 1)));
    expect(batches.map((b) => b.length)).toEqual([BATCH_MAX_RUNS, BATCH_MAX_RUNS, 1]);
  });

  it("caps occurrences per batch", () => {
    const batches = chunkBackfillRuns([run(1, 600), run(2, 600), run(3, 400)]);
    expect(batches.map((b) => b.map((r) => r.runId))).toEqual([["run-00001"], ["run-00002", "run-00003"]]);
    for (const b of batches) expect(b.reduce((n, r) => n + r.produced.length, 0)).toBeLessThanOrEqual(BATCH_MAX_OCCURRENCES);
  });
});

describe("findingChild", () => {
  const child = (id: string, start: string, end: string | null) => ({ id, startedAt: start, completedAt: end, updatedAt: end ?? start });

  it("takes the one child whose window holds the find", () => {
    const children = [child("first", "2026-09-01T10:00:00Z", "2026-09-01T10:00:20Z"), child("retry", "2026-09-03T10:00:00Z", "2026-09-03T10:00:05Z")];
    expect(findingChild(children, "2026-09-01T10:00:12Z")?.id).toBe("first");
    expect(findingChild(children, "2026-09-02T10:00:00Z")).toBeNull();
  });

  it("names nobody when two windows hold it", () => {
    expect(findingChild([child("a", "2026-09-01T10:00:00Z", "2026-09-01T10:01:00Z"), child("b", "2026-09-01T10:00:30Z", "2026-09-01T10:02:00Z")], "2026-09-01T10:00:45Z")).toBeNull();
  });
});

describe("resolveRepointedFinds", () => {
  it("confirms with runs-service, counts what it cannot confirm", async () => {
    const lookup = vi.fn(async (_org: string, caller: string) =>
      caller === "caller-find" ? [{ id: RUN_A, startedAt: "2026-09-01T10:00:00Z", completedAt: "2026-09-01T10:00:10Z", updatedAt: "2026-09-01T10:00:10Z" }] : [],
    );
    const out = await resolveRepointedFinds(
      [
        { orgId: "org", leadId: "lead-1", servedAt: "2026-09-01T10:00:05Z", callerRunId: "caller-find", emailChecked: false },
        { orgId: "org", leadId: "lead-1", servedAt: "2026-09-01T10:00:05Z", callerRunId: "caller-retry", emailChecked: false },
      ],
      lookup,
    );
    expect(out.finds).toEqual([{ source: "repointed", runId: RUN_A, orgId: "org", leadId: "lead-1", emailChecked: false }]);
    expect(out.unconfirmed).toBe(1);
  });
});

describe("declareBackfillBatch", () => {
  const runs = [
    { runId: RUN_A, orgId: "org", produced: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "l1" }], consumed: [] },
    { runId: RUN_B, orgId: "org", produced: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "l2" }], consumed: [] },
  ];

  it("declares every run at its own start, redate on, through one call", async () => {
    const post = vi.fn(async () => ({ status: 201, json: { recordedCount: 2, alreadyRecordedCount: 0, redatedCount: 0 }, text: "" }));
    const out = await declareBackfillBatch(runs, post);
    expect(out).toEqual({ recorded: 2, alreadyRecorded: 0, redated: 0, refusedRuns: [] });
    expect(post).toHaveBeenCalledWith({
      runs: [
        { runId: RUN_A, produced: runs[0].produced, occurredAt: "run_started_at", redate: true },
        { runId: RUN_B, produced: runs[1].produced, occurredAt: "run_started_at", redate: true },
      ],
    });
  });

  it("sets a refused run aside with its reason and re-sends the rest", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({ status: 422, json: { error: "invalid_runs", details: { invalid: [{ runId: RUN_B, reason: "run_not_found" }] } }, text: "" })
      .mockResolvedValueOnce({ status: 200, json: { recordedCount: 0, alreadyRecordedCount: 1, redatedCount: 0 }, text: "" });
    const out = await declareBackfillBatch(runs, post);
    expect(out).toEqual({ recorded: 0, alreadyRecorded: 1, redated: 0, refusedRuns: [{ runId: RUN_B, reason: "run_not_found" }] });
    expect((post.mock.calls[1][0] as { runs: Array<{ runId: string }> }).runs.map((r) => r.runId)).toEqual([RUN_A]);
  });

  it("throws on anything the door did not refuse run by run (the re-run resumes)", async () => {
    const post = vi.fn(async () => ({ status: 502, json: { error: "outcome_catalogue_unavailable" }, text: "outcome_catalogue_unavailable" }));
    await expect(declareBackfillBatch(runs, post)).rejects.toThrow(/502/);
  });
});
