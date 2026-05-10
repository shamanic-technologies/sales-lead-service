import { describe, it, expect, beforeEach } from "vitest";
import {
  tryAcquire,
  release,
  inflightKey,
  __resetInflight,
} from "../../src/lib/inflight-guard.js";

describe("inflight-guard", () => {
  beforeEach(() => {
    __resetInflight();
  });

  it("acquires when no in-flight entry for the key", () => {
    const result = tryAcquire("org-1", "camp-1", {
      parentRunId: "run-1",
      brandIds: ["b1"],
      startedAt: 1_000_000,
      workflowSlug: "wf",
      featureSlug: "feat",
    });
    expect(result).toEqual({ acquired: true });
  });

  it("rejects a second acquire for same (orgId, campaignId)", () => {
    const first = tryAcquire("org-1", "camp-1", {
      parentRunId: "run-A",
      brandIds: ["b1"],
      startedAt: 1_000_000,
      workflowSlug: "wf",
      featureSlug: "feat",
    });
    expect(first.acquired).toBe(true);

    const second = tryAcquire("org-1", "camp-1", {
      parentRunId: "run-B",
      brandIds: ["b2"],
      startedAt: 2_000_000,
    });
    expect(second.acquired).toBe(false);
    if (!second.acquired) {
      expect(second.existing.parentRunId).toBe("run-A");
      expect(second.existing.brandIds).toEqual(["b1"]);
      expect(second.existing.startedAt).toBe(1_000_000);
      expect(second.existing.workflowSlug).toBe("wf");
      expect(second.existing.featureSlug).toBe("feat");
    }
  });

  it("allows acquire after release", () => {
    tryAcquire("org-1", "camp-1", {
      parentRunId: "run-A",
      brandIds: ["b1"],
      startedAt: 1_000_000,
    });
    release("org-1", "camp-1");
    const result = tryAcquire("org-1", "camp-1", {
      parentRunId: "run-B",
      brandIds: ["b1"],
      startedAt: 2_000_000,
    });
    expect(result.acquired).toBe(true);
  });

  it("isolates by campaignId — same org, different campaign acquires independently", () => {
    const a = tryAcquire("org-1", "camp-A", {
      parentRunId: "run-A",
      brandIds: ["b1"],
      startedAt: 1_000_000,
    });
    const b = tryAcquire("org-1", "camp-B", {
      parentRunId: "run-B",
      brandIds: ["b1"],
      startedAt: 1_000_000,
    });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });

  it("isolates by orgId — different orgs, same campaign id string acquire independently", () => {
    const a = tryAcquire("org-1", "camp-1", {
      parentRunId: "run-A",
      brandIds: ["b1"],
      startedAt: 1_000_000,
    });
    const b = tryAcquire("org-2", "camp-1", {
      parentRunId: "run-B",
      brandIds: ["b1"],
      startedAt: 1_000_000,
    });
    expect(a.acquired).toBe(true);
    expect(b.acquired).toBe(true);
  });

  it("inflightKey composes orgId and campaignId deterministically", () => {
    expect(inflightKey("org-1", "camp-1")).toBe("org-1:camp-1");
  });
});
