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

describe("recordEmploymentHistory — one current employer per lead (neutral gateway Person)", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    updateCalls.length = 0;
    selectResults.clear();
    findFirstOrg.mockReset();
    // Top-level org already exists by domain → upsertOrganizationFromPerson takes
    // the UPDATE branch and returns "org-top" (no organizations INSERT).
    findFirstOrg.mockResolvedValue({ id: "org-top" });
  });

  // The gateway provides only a single top-level org (no employment-history array).
  const person = {
    providerPersonId: "person-1",
    title: "Founder",
    organization: { name: "Casco Bay", domain: "cascobay.com" },
  };

  it("expires all current rows for the lead before writing", async () => {
    selectResults.set(leadsOrganizations, []); // fresh lead, no existing current link
    const { recordEmploymentHistory } = await import("../../src/lib/leads-registry.js");
    await recordEmploymentHistory({ leadId: "lead-1", person: person as never });

    expect(leadsOrgUpdates()).toContainEqual(expect.objectContaining({ current: false }));
    // the expire UPDATE is the first leads_organizations update
    expect(leadsOrgUpdates()[0]).toMatchObject({ current: false });
  });

  it("marks the top-level org current=true via insert when no existing link", async () => {
    selectResults.set(leadsOrganizations, []); // no existing current link → insert
    const { recordEmploymentHistory } = await import("../../src/lib/leads-registry.js");
    await recordEmploymentHistory({ leadId: "lead-1", person: person as never });

    const inserts = leadsOrgInserts();
    expect(inserts).toContainEqual(
      expect.objectContaining({ organizationId: "org-top", current: true, title: "Founder" }),
    );
    // exactly one current=true link written
    expect(inserts.filter((v) => v.current === true)).toHaveLength(1);
  });

  it("re-enrich is idempotent: existing current link is UPDATED, not inserted", async () => {
    selectResults.set(leadsOrganizations, [{ id: "link-top" }]); // current link already exists
    const { recordEmploymentHistory } = await import("../../src/lib/leads-registry.js");
    await recordEmploymentHistory({ leadId: "lead-1", person: person as never });

    expect(leadsOrgUpdates()).toContainEqual(expect.objectContaining({ current: true, title: "Founder" }));
    // no current=true link was inserted (would grow row count on every enrich)
    expect(leadsOrgInserts().filter((v) => v.current === true)).toHaveLength(0);
  });

  it("does not mint an org when the top-level org already exists by domain", async () => {
    selectResults.set(leadsOrganizations, []);
    const { recordEmploymentHistory } = await import("../../src/lib/leads-registry.js");
    await recordEmploymentHistory({ leadId: "lead-1", person: person as never });

    expect(orgInserts()).toHaveLength(0);
  });

  it("mints the top-level org when none exists by domain", async () => {
    findFirstOrg.mockResolvedValue(undefined); // org not found → insert it
    selectResults.set(leadsOrganizations, []);
    const { recordEmploymentHistory } = await import("../../src/lib/leads-registry.js");
    await recordEmploymentHistory({ leadId: "lead-1", person: person as never });

    expect(orgInserts()).toHaveLength(1);
    expect(orgInserts()[0].values).toMatchObject({ name: "Casco Bay", primaryDomain: "cascobay.com" });
  });
});
