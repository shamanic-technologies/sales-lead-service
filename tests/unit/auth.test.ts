import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Response, NextFunction } from "express";

const setTagMock = vi.fn();
vi.mock("@sentry/node", () => ({
  setTag: (...args: unknown[]) => setTagMock(...args),
}));

import {
  apiKeyAuth,
  requireOrgId,
  requireRunId,
  type AuthenticatedRequest,
} from "../../src/middleware/auth.js";

function makeRes() {
  const res: Partial<Response> & { _status?: number; _body?: unknown } = {};
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res as Response;
  }) as unknown as Response["status"];
  res.json = vi.fn((body: unknown) => {
    res._body = body;
    return res as Response;
  }) as unknown as Response["json"];
  return res as Response & { _status?: number; _body?: unknown };
}

function makeReq(headers: Record<string, string>): AuthenticatedRequest {
  return { headers } as unknown as AuthenticatedRequest;
}

describe("apiKeyAuth", () => {
  it("rejects missing key", () => {
    const req = makeReq({});
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    apiKeyAuth(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects wrong key", () => {
    const req = makeReq({ "x-api-key": "wrong" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    apiKeyAuth(req, res, next);
    expect(res._status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("accepts correct key", () => {
    const req = makeReq({ "x-api-key": "test-api-key" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    apiKeyAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("requireOrgId", () => {
  beforeEach(() => {
    setTagMock.mockReset();
  });

  it("400 when x-org-id missing", () => {
    const req = makeReq({});
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireOrgId(req, res, next);
    expect(res._status).toBe(400);
  });

  it("parses all identity headers and sets Sentry tags", () => {
    const req = makeReq({
      "x-org-id": "org-1",
      "x-user-id": "user-1",
      "x-run-id": "run-1",
      "x-campaign-id": "camp-1",
      "x-brand-id": "brand-1,brand-2",
      "x-workflow-slug": "wf-slug",
      "x-feature-slug": "feat-slug",
      "x-goal": "signup",
      "x-active-goal-id": "goal-1",
      "x-brand-profile-id": "brand-profile-1",
      "x-customer-persona-id": "persona-1",
      "x-customer-profile-id": "customer-profile-1",
    });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireOrgId(req, res, next);

    expect(req.orgId).toBe("org-1");
    expect(req.userId).toBe("user-1");
    expect(req.runId).toBe("run-1");
    expect(req.campaignId).toBe("camp-1");
    expect(req.brandIds).toEqual(["brand-1", "brand-2"]);
    expect(req.workflowSlug).toBe("wf-slug");
    expect(req.featureSlug).toBe("feat-slug");
    expect(req.goal).toBe("signup");
    expect(req.activeGoalId).toBe("goal-1");
    expect(req.brandProfileId).toBe("brand-profile-1");
    expect(req.customerPersonaId).toBe("persona-1");
    expect(req.customerProfileId).toBe("customer-profile-1");
    expect(next).toHaveBeenCalledOnce();

    const tags = Object.fromEntries(setTagMock.mock.calls);
    expect(tags).toMatchObject({
      orgId: "org-1",
      userId: "user-1",
      runId: "run-1",
      campaignId: "camp-1",
      brandId: "brand-1,brand-2",
      workflowSlug: "wf-slug",
      featureSlug: "feat-slug",
      goal: "signup",
      activeGoalId: "goal-1",
      brandProfileId: "brand-profile-1",
      customerPersonaId: "persona-1",
      customerProfileId: "customer-profile-1",
    });
  });
});

describe("requireRunId", () => {
  it("400 when x-run-id missing on the request", () => {
    const req = makeReq({});
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireRunId(req, res, next);
    expect(res._status).toBe(400);
    expect(res._body).toEqual({ error: "x-run-id header required" });
    expect(next).not.toHaveBeenCalled();
  });

  it("passes when runId already set on req (after requireOrgId)", () => {
    const req = makeReq({});
    req.runId = "run-from-orgid";
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireRunId(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.runId).toBe("run-from-orgid");
  });

  it("falls back to header when req.runId not yet populated (used on /internal routes)", () => {
    const req = makeReq({ "x-run-id": "hdr-run" });
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    requireRunId(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.runId).toBe("hdr-run");
  });
});
