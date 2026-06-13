import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/runs-client.js", () => ({
  listRuns: vi.fn(),
  updateRun: vi.fn().mockResolvedValue(undefined),
}));

import { listRuns, updateRun } from "../../src/lib/runs-client.js";
import { checkConcurrentBufferNext } from "../../src/lib/inflight-guard.js";
import { PULL_NEXT_TIMEOUT_MS } from "../../src/config.js";

const listRunsMock = listRuns as unknown as ReturnType<typeof vi.fn>;
const updateRunMock = updateRun as unknown as ReturnType<typeof vi.fn>;

// A run is treated as orphaned past PULL_NEXT_TIMEOUT_MS + 60s grace.
const STALE_AGE_MS = PULL_NEXT_TIMEOUT_MS + 120_000;

describe("inflight-guard.checkConcurrentBufferNext", () => {
  beforeEach(() => {
    listRunsMock.mockReset();
    updateRunMock.mockReset();
    updateRunMock.mockResolvedValue(undefined);
  });

  it("returns blocked=false when no in-flight runs found", async () => {
    listRunsMock.mockResolvedValueOnce([]);

    const result = await checkConcurrentBufferNext({
      orgId: "org-1",
      campaignId: "camp-1",
      attemptedParentRunId: "run-new",
      attemptedBrandIds: ["b1"],
      attemptedWorkflowSlug: "wf",
      attemptedFeatureSlug: "feat",
    });

    expect(result.blocked).toBe(false);
    expect(listRunsMock).toHaveBeenCalledWith({
      orgId: "org-1",
      campaignId: "camp-1",
      serviceName: "lead-service",
      status: "running",
      limit: 2,
    });
  });

  it("returns blocked=true with detail when an in-flight run exists", async () => {
    const startedAt = new Date(Date.now() - 5000).toISOString();
    listRunsMock.mockResolvedValueOnce([
      {
        id: "run-existing",
        parentRunId: "parent-existing",
        campaignId: "camp-1",
        startedAt,
        brandIds: ["b1", "b2"],
        workflowSlug: "wf-old",
        featureSlug: "feat-old",
      },
    ]);

    const result = await checkConcurrentBufferNext({
      orgId: "org-1",
      campaignId: "camp-1",
      attemptedParentRunId: "run-new",
      attemptedBrandIds: ["b3"],
      attemptedWorkflowSlug: "wf-new",
      attemptedFeatureSlug: "feat-new",
    });

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.detail).toContain("orgId=org-1");
      expect(result.detail).toContain("campaignId=camp-1");
      expect(result.detail).toContain("run-existing");
      expect(result.detail).toContain("parent-existing");
      expect(result.detail).toContain(startedAt);
      expect(result.detail).toContain("elapsedMs=");
      expect(result.detail).toContain("wf-old");
      expect(result.detail).toContain("feat-old");
      expect(result.detail).toContain("Rejected");
      expect(result.detail).toContain("run-new");
      expect(result.detail).toContain("b3");
      expect(result.detail).toContain("wf-new");
      expect(result.detail).toContain("feat-new");
    }
  });

  it("does NOT block on a single orphaned run (older than the stale threshold) and clears it", async () => {
    const startedAt = new Date(Date.now() - STALE_AGE_MS).toISOString();
    listRunsMock.mockResolvedValueOnce([
      {
        id: "run-orphan",
        parentRunId: "parent-orphan",
        campaignId: "camp-1",
        startedAt,
        brandIds: ["b1"],
        workflowSlug: "wf",
        featureSlug: "feat",
      },
    ]);

    const result = await checkConcurrentBufferNext({
      orgId: "org-1",
      campaignId: "camp-1",
      attemptedParentRunId: "run-new",
      attemptedBrandIds: ["b1"],
    });

    expect(result.blocked).toBe(false);
    expect(updateRunMock).toHaveBeenCalledWith("run-orphan", "failed", {
      orgId: "org-1",
      campaignId: "camp-1",
    });
  });

  it("blocks on a fresh run even when an orphaned run is also present, clearing only the orphan", async () => {
    const orphanStartedAt = new Date(Date.now() - STALE_AGE_MS).toISOString();
    const freshStartedAt = new Date(Date.now() - 5000).toISOString();
    listRunsMock.mockResolvedValueOnce([
      {
        id: "run-orphan",
        parentRunId: "parent-orphan",
        campaignId: "camp-1",
        startedAt: orphanStartedAt,
        brandIds: ["b1"],
        workflowSlug: "wf",
        featureSlug: "feat",
      },
      {
        id: "run-fresh",
        parentRunId: "parent-fresh",
        campaignId: "camp-1",
        startedAt: freshStartedAt,
        brandIds: ["b2"],
        workflowSlug: "wf",
        featureSlug: "feat",
      },
    ]);

    const result = await checkConcurrentBufferNext({
      orgId: "org-1",
      campaignId: "camp-1",
      attemptedParentRunId: "run-new",
      attemptedBrandIds: ["b3"],
    });

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.detail).toContain("run-fresh");
      expect(result.detail).not.toContain("run-orphan");
    }
    expect(updateRunMock).toHaveBeenCalledWith("run-orphan", "failed", {
      orgId: "org-1",
      campaignId: "camp-1",
    });
    expect(updateRunMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT block when all in-flight runs are orphaned", async () => {
    const startedAt = new Date(Date.now() - STALE_AGE_MS).toISOString();
    listRunsMock.mockResolvedValueOnce([
      { id: "orphan-1", parentRunId: null, campaignId: "camp-1", startedAt, brandIds: null, workflowSlug: null, featureSlug: null },
      { id: "orphan-2", parentRunId: null, campaignId: "camp-1", startedAt, brandIds: null, workflowSlug: null, featureSlug: null },
    ]);

    const result = await checkConcurrentBufferNext({
      orgId: "org-1",
      campaignId: "camp-1",
      attemptedParentRunId: "run-new",
      attemptedBrandIds: ["b1"],
    });

    expect(result.blocked).toBe(false);
    expect(updateRunMock).toHaveBeenCalledTimes(2);
  });

  it("propagates listRuns errors (no silent fallback)", async () => {
    listRunsMock.mockRejectedValueOnce(new Error("runs-service down"));

    await expect(
      checkConcurrentBufferNext({
        orgId: "org-1",
        campaignId: "camp-1",
        attemptedParentRunId: "run-new",
        attemptedBrandIds: ["b1"],
      }),
    ).rejects.toThrow(/runs-service down/);
  });

  it("handles missing optional fields on existing run gracefully", async () => {
    listRunsMock.mockResolvedValueOnce([
      {
        id: "run-existing",
        parentRunId: null,
        campaignId: "camp-1",
        startedAt: new Date().toISOString(),
        brandIds: null,
        workflowSlug: null,
        featureSlug: null,
      },
    ]);

    const result = await checkConcurrentBufferNext({
      orgId: "org-1",
      campaignId: "camp-1",
      attemptedParentRunId: "run-new",
      attemptedBrandIds: ["b1"],
    });

    expect(result.blocked).toBe(true);
    if (result.blocked) {
      expect(result.detail).toContain("run-existing");
      expect(result.detail).toContain("parentRunId=none");
    }
  });
});
