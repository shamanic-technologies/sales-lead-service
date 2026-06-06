import { describe, it, expect, vi, beforeEach } from "vitest";
import { organizations, leadsOrganizations } from "../../src/db/schema.js";

// Call recorders
const insertCalls: { table: unknown; values: unknown }[] = [];
const updateCalls: { table: unknown; set: unknown }[] = [];
// table -> rows returned by select(...).from(table).where(...).limit(n)
const selectResults = new Map<unknown, unknown[]>();
const findFirstOrg = vi.fn();

function makeInsert(table: unknown) {
  return {
    values: (obj: unknown) => {
      insertCalls.push({ table, values: obj });
      // organizations inserts return a new id (resolveHistoryOrgId / upsert insert path)
      const returningVal = table === organizations ? [{ id: "org-inserted" }] : [];
      const p = Promise.resolve(returningVal) as Promise<unknown[]> & {
        onConflictDoNothing: () => Promise<unknown[]>;
        returning: () => Promise<unknown[]>;
      };
      p.onConflictDoNothing = () => Promise.resolve(returningVal);
      p.returning = () => Promise.resolve(returningVal);
      return p;
    },
  };
}

function makeUpdate(table: unknown) {
  return {
    set: (obj: unknown) => {
      updateCalls.push({ table, set: obj });
      return { where: () => Promise.resolve(undefined) };
    },
  };
}

function makeSelect() {
  return {
    from: (table: unknown) => ({
      where: () => ({
        limit: () => Promise.resolve(selectResults.get(table) ?? []),
      }),
    }),
  };
}

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: (table: unknown) => makeInsert(table),
    update: (table: unknown) => makeUpdate(table),
    select: () => makeSelect(),
    query: {
      organizations: { findFirst: (...a: unknown[]) => findFirstOrg(...a) },
    },
  },
}));

function leadsOrgInserts() {
  return insertCalls.filter((c) => c.table === leadsOrganizations).map((c) => c.values as Record<string, unknown>);
}
function orgInserts() {
  return insertCalls.filter((c) => c.table === organizations);
}
function leadsOrgUpdates() {
  return updateCalls.filter((c) => c.table === leadsOrganizations).map((c) => c.set as Record<string, unknown>);
}

describe("recordEmploymentHistory — one current employer per lead", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    updateCalls.length = 0;
    selectResults.clear();
    findFirstOrg.mockReset();
    // Top-level org already exists → upsertOrganizationFromPerson takes the UPDATE
    // branch and returns "org-top" (no organizations INSERT from the top-level path).
    findFirstOrg.mockResolvedValue({ id: "org-top" });
  });

  const person = {
    id: "person-1",
    title: "Founder",
    organizationId: "apollo-org-1",
    organizationName: "Casco Bay",
    employmentHistory: [
      { title: "Founder", organizationName: "Casco Bay", startDate: "2018-01-01", current: true },
      { title: "PM", organizationName: "Old Co", startDate: "2014-01-01", endDate: "2017-12-31", current: false },
    ],
  };

  it("expires all current rows for the lead before writing", async () => {
    selectResults.set(leadsOrganizations, []); // fresh lead, no existing current link
    selectResults.set(organizations, [{ id: "org-old" }]); // Old Co reused by name
    const { recordEmploymentHistory } = await import("../../src/lib/leads-registry.js");
    await recordEmploymentHistory({ leadId: "lead-1", person: person as never });

    expect(leadsOrgUpdates()).toContainEqual(expect.objectContaining({ current: false }));
    // the expire UPDATE is the first leads_organizations update
    expect(leadsOrgUpdates()[0]).toMatchObject({ current: false });
  });

  it("marks exactly the top-level org current=true; history rows are current=false", async () => {
    selectResults.set(leadsOrganizations, []); // no existing current link → insert
    selectResults.set(organizations, [{ id: "org-old" }]); // Old Co reused
    const { recordEmploymentHistory } = await import("../../src/lib/leads-registry.js");
    await recordEmploymentHistory({ leadId: "lead-1", person: person as never });

    const inserts = leadsOrgInserts();
    // canonical current employer inserted current=true for org-top
    expect(inserts).toContainEqual(
      expect.objectContaining({ organizationId: "org-top", current: true, title: "Founder" }),
    );
    // past employment (Old Co) inserted current=false
    expect(inserts).toContainEqual(
      expect.objectContaining({ organizationId: "org-old", current: false, title: "PM" }),
    );
    // exactly one current=true link written
    expect(inserts.filter((v) => v.current === true)).toHaveLength(1);
    // the Casco Bay history entry (matches top-level org) is NOT inserted twice
    expect(inserts.filter((v) => v.organizationId === "org-top")).toHaveLength(1);
  });

  it("re-enrich is idempotent: existing current link is UPDATED, not inserted", async () => {
    selectResults.set(leadsOrganizations, [{ id: "link-top" }]); // current link already exists
    selectResults.set(organizations, [{ id: "org-old" }]);
    const { recordEmploymentHistory } = await import("../../src/lib/leads-registry.js");
    await recordEmploymentHistory({ leadId: "lead-1", person: person as never });

    // current employer set via UPDATE
    expect(leadsOrgUpdates()).toContainEqual(expect.objectContaining({ current: true, title: "Founder" }));
    // no current=true link was inserted (would grow row count on every enrich)
    expect(leadsOrgInserts().filter((v) => v.current === true)).toHaveLength(0);
  });

  it("reuses an existing org by name for history — no fresh placeholder org minted", async () => {
    selectResults.set(leadsOrganizations, []);
    selectResults.set(organizations, [{ id: "org-old" }]); // Old Co already exists by name
    const { recordEmploymentHistory } = await import("../../src/lib/leads-registry.js");
    await recordEmploymentHistory({ leadId: "lead-1", person: person as never });

    // top-level org existed (UPDATE branch) and history org reused → zero organizations INSERTs
    expect(orgInserts()).toHaveLength(0);
  });

  it("mints a history org only when none exists by name", async () => {
    selectResults.set(leadsOrganizations, []);
    selectResults.set(organizations, []); // Old Co not found → insert it
    const { recordEmploymentHistory } = await import("../../src/lib/leads-registry.js");
    await recordEmploymentHistory({ leadId: "lead-1", person: person as never });

    expect(orgInserts()).toHaveLength(1);
    expect(orgInserts()[0].values).toMatchObject({ name: "Old Co" });
  });
});
