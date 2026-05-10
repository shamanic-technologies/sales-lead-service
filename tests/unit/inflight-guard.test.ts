import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/lib/runs-client.js", () => ({
  listRuns: vi.fn(),
}));

import { listRuns } from "../../src/lib/runs-client.js";
import { checkConcurrentBufferNext } from "../../src/lib/inflight-guard.js";

const listRunsMock = listRuns as unknown as ReturnType<typeof vi.fn>;

describe("inflight-guard.checkConcurrentBufferNext", () => {
  beforeEach(() => {
    listRunsMock.mockReset();
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
