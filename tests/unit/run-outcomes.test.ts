/**
 * COST-ACCOUNTING-1023-P1: every outcome key lead-service declares at runs-service and the subject it names. A person's
 * occurrences name their LEAD here; a company researched names its normalized domain (the key observations live on).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: {} }));

const { leadFoundDeclaration, companyResearchedDeclaration, declarationKey, deliverRunOutcomes } = await import("../../src/lib/run-outcomes.js");

describe("outcome declarations", () => {
  it("a find produces lead_found on the serve run and consumes the email check it handed out", () => {
    expect(leadFoundDeclaration({ orgId: "o", runId: "r", leadId: "L", emailChecked: true })).toEqual({
      orgId: "o",
      runId: "r",
      produced: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "L" }],
      consumed: [{ outcomeKey: "email_checked", subjectService: "lead-service", subjectId: "L" }],
    });
  });

  it("a find served with no verification verdict consumes nothing", () => {
    expect(leadFoundDeclaration({ orgId: "o", runId: "r", leadId: "L", emailChecked: false }).consumed).toEqual([]);
  });

  it("a research run produces company_researched per company domain, once each", () => {
    const d = companyResearchedDeclaration({ orgId: "o", runId: "r", domains: ["b.com", "a.com", "b.com"] });
    expect(d.produced).toEqual([
      { outcomeKey: "company_researched", subjectService: "lead-service", subjectId: "a.com" },
      { outcomeKey: "company_researched", subjectService: "lead-service", subjectId: "b.com" },
    ]);
    expect(d.consumed).toEqual([]);
  });

  it("one outbox key per declaration (a replay never queues twice)", () => {
    const d = leadFoundDeclaration({ orgId: "o", runId: "r", leadId: "L", emailChecked: true });
    expect(declarationKey(d)).toBe("r:lead_found:L");
    expect(declarationKey(leadFoundDeclaration({ orgId: "o", runId: "r", leadId: "L", emailChecked: false }))).toBe(declarationKey(d));
  });
});

describe("delivery to runs-service", () => {
  afterEach(() => vi.unstubAllGlobals());
  const d = leadFoundDeclaration({ orgId: "o", runId: "r", leadId: "L", emailChecked: false });
  const answer = (status: number, body = "{}") => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));

  it("posts the declaration on the run with the run's org", async () => {
    const fetchMock = vi.fn(async (_u: string, _i: RequestInit) => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await deliverRunOutcomes(d)).toEqual({ kind: "delivered" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/v1\/runs\/r\/outcomes$/);
    expect((init.headers as Record<string, string>)["x-org-id"]).toBe("o");
    expect(JSON.parse(init.body as string)).toEqual({ produced: d.produced, consumed: [] });
  });

  it("a replay answered already_recorded (200) is delivered", async () => {
    answer(200, JSON.stringify({ recordedCount: 0, alreadyRecordedCount: 1 }));
    expect((await deliverRunOutcomes(d)).kind).toBe("delivered");
  });

  it("400/404/409 are refusals kept for good; 5xx and 502 are retried", async () => {
    for (const s of [400, 404, 409]) {
      answer(s);
      expect((await deliverRunOutcomes(d)).kind).toBe("refused");
    }
    for (const s of [500, 502, 503, 401]) {
      answer(s);
      expect((await deliverRunOutcomes(d)).kind).toBe("retry");
    }
  });
});
