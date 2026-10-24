/**
 * LEAD-IDENTIFIED-CONSUME-1024: a live serve of a person from the client's CRM declares `lead_found` produced AND
 * crm-service's `lead_identified` (its relation key) consumed; a serve of anyone else declares exactly what it did.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const execute = vi.fn();
vi.mock("../../src/db/index.js", () => ({ db: { execute: (...a: unknown[]) => execute(...a) } }));
const declared: unknown[] = [];
vi.mock("../../src/lib/run-outcomes.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/run-outcomes.js")>()),
  declareRunOutcomes: (d: unknown) => declared.push(d),
}));

const { pickRelationKey, declareLeadFound } = await import("../../src/lib/crm-lead-identified.js");

const flush = () => new Promise((r) => setTimeout(r, 0));
const base = { orgId: "o", runId: "r", leadId: "L", brandIds: ["b"], emailChecked: true };

describe("pickRelationKey", () => {
  it("one relation = it", () => {
    expect(pickRelationKey([{ relationKey: "rel:p:pro", companyId: "" }], "c1")).toBe("rel:p:pro");
  });
  it("several = the one at the lead's company ('' = unknown on both sides)", () => {
    const c = [
      { relationKey: "rel:p:pro", companyId: "" },
      { relationKey: "rel:p:org:c1", companyId: "c1" },
    ];
    expect(pickRelationKey(c, "c1")).toBe("rel:p:org:c1");
    expect(pickRelationKey(c, null)).toBe("rel:p:pro");
  });
  it("still not one = none, never a pick", () => {
    expect(pickRelationKey([{ relationKey: "rel:a:org:c1", companyId: "c1" }, { relationKey: "rel:b:org:c1", companyId: "c1" }], "c1")).toBeNull();
    expect(pickRelationKey([], "c1")).toBeNull();
  });
});

describe("declareLeadFound (live serve)", () => {
  beforeEach(() => {
    execute.mockReset();
    declared.length = 0;
  });

  it("a CRM-registry lead: lead_found produced, email_checked + crm-service's lead_identified consumed", async () => {
    execute.mockResolvedValue([{ i: 0, lead_company: "", relation_key: "rel:p1:pro", company_id: "" }]);
    declareLeadFound({ ...base, fromCrm: true });
    await flush();
    expect(declared).toEqual([
      {
        orgId: "o",
        runId: "r",
        produced: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "L" }],
        consumed: [
          { outcomeKey: "email_checked", subjectService: "lead-service", subjectId: "L" },
          { outcomeKey: "lead_identified", subjectService: "crm-service", subjectId: "rel:p1:pro" },
        ],
      },
    ]);
  });

  it("a non-CRM lead (Apollo, signals...): exactly today's declaration, the registry never read", async () => {
    declareLeadFound({ ...base, fromCrm: false });
    await flush();
    expect(execute).not.toHaveBeenCalled();
    expect(declared).toEqual([
      {
        orgId: "o",
        runId: "r",
        produced: [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: "L" }],
        consumed: [{ outcomeKey: "email_checked", subjectService: "lead-service", subjectId: "L" }],
      },
    ]);
  });

  it("a CRM lead no crm relation identified consumes nothing new", async () => {
    execute.mockResolvedValue([]);
    declareLeadFound({ ...base, emailChecked: false, fromCrm: true });
    await flush();
    expect((declared[0] as { consumed: unknown[] }).consumed).toEqual([]);
  });

  it("an unreadable registry still declares the find (the backfill adds the consumption later)", async () => {
    execute.mockRejectedValue(new Error("db down"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    declareLeadFound({ ...base, emailChecked: false, fromCrm: true });
    await flush();
    expect((declared[0] as { produced: unknown[] }).produced).toHaveLength(1);
    err.mockRestore();
  });
});
