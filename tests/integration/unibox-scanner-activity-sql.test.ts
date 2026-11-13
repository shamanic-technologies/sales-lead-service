/**
 * UNIBOX-NEWSLETTER-1113 against a REAL database: a mail scanner opening a newsletter link (a product event the brand's
 * server recorded in NO session) is never activity of the person: it does not date their Unibox row, does not move their
 * thread nor make a direct conversation. A product event carried by a real session still counts, and a send of ours
 * (a newsletter included, `message_out`) dates the row as OUR activity. The subscriber stays in the Unibox.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const catalogue = {
  object: "step",
  lifecycleLadder: [{ key: "lead_found", rank: 1, label: "Lead found" }],
  rows: [["lead_found", 1], ["website_visit", 1]].map(([key, lifecycleRank]) => ({ key, lifecycleRank })),
};
vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async (url: string, init?: { body?: string }) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const u = String(url);
    if (u.endsWith("/public/catalogue/steps")) return json(catalogue);
    if (u.endsWith("/internal/people/relations/latest-messages")) {
      const { relationKeys } = JSON.parse(String(init?.body)) as { relationKeys: string[] };
      return json({ relations: relationKeys.map((relationKey) => ({ relationKey, status: "no_message", reason: null, message: null, gaps: [] })) });
    }
    throw new Error(`unexpected fetch ${u}`);
  },
}));
vi.mock("../../src/lib/org-members.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/org-members.js")>()),
  loadOrgMemberKeys: async () => new Set<string>(),
}));
vi.mock("../../src/lib/company-client.js", () => ({
  MAX_COMPANIES_PER_REQUEST: 1000,
  getCompanies: async () => [],
  CompanyServiceError: class extends Error {},
}));

const { db } = await import("../../src/db/index.js");
const { clearRegistry, connectionTag } = await import("../helpers/crm-registry.js");
const { refreshSubjects } = await import("../../src/lib/relationship-subjects.js");
const { refreshUniboxRows, readUniboxPage, resetLifecycleCatalogueCache } = await import("../../src/lib/unibox-model.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("unibox activity ignores mail scanners (UNIBOX-NEWSLETTER-1113)", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const scope = { orgId, brandId };
  const subscriber = randomUUID(); // only scanner hits on newsletter links
  const user = randomUUID(); // scanner hits + one product event in a real session
  const reader = randomUUID(); // scanner hits + a newsletter we sent them
  let seq = BigInt(Date.now()) * 1000n + 950_000_000n;

  async function crmFact(personKey: string, human: string, type: string, at: string, payload: Record<string, unknown>): Promise<void> {
    seq += 1n;
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${seq.toString()}::bigint, ${orgId}, ${brandId}, ${personKey}, ${personKey}, NULL, '{}'::text[], '{}'::text[], ${type},
        ${at}::timestamptz, 'event', 'posthog', ${randomUUID()}, ${JSON.stringify(payload)}::jsonb, ${JSON.stringify({ humanId: human })}::jsonb)
    `);
  }
  const scanner = { event: "newsletter_link_identified", text: "Newsletter link identified · source: server", sessionId: null };

  afterAll(async () => {
    await clearRegistry(orgId);
    for (const t of ["crm_facts", "relationship_subjects", "unibox_rows"]) await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
  });

  it("a scanner hit dates nobody; a session-carrying event and our newsletter send do", async () => {
    resetLifecycleCatalogueCache();
    for (const [human, key] of [[subscriber, "posthog:sub"], [user, "posthog:user"], [reader, "email:reader@x.io"]] as const) {
      await connectionTag({ orgId, brandId, human, personKey: key });
    }
    await refreshSubjects(scope);
    const [known] = (await db.execute(sql`
      SELECT first_seen_at FROM relationship_subjects WHERE org_id = ${orgId} AND human_id = ${subscriber}::uuid`)) as unknown as Array<{ first_seen_at: Date | string }>;
    const knownSince = new Date(known.first_seen_at).toISOString();

    for (const [human, key] of [[subscriber, "posthog:sub"], [user, "posthog:user"], [reader, "email:reader@x.io"]] as const) {
      await crmFact(key, human, "product_event", "2099-01-01T12:57:59Z", scanner);
    }
    await crmFact("posthog:user", user, "product_event", "2098-11-10T10:00:00Z", { event: "onboarding_step", text: "Connected a mailbox", sessionId: "s-1" });
    await crmFact("email:reader@x.io", reader, "message_out", "2098-11-12T08:00:00Z", { text: "This week's newsletter", channel: "email" });

    await refreshSubjects(scope);
    await refreshUniboxRows(scope);

    const page = await readUniboxPage(scope, {}, { limit: 10, cursor: null });
    // The subscriber stays in the Unibox, dated the day they became known, never by the scanner (2099 hit).
    expect(page.total).toBe(3);
    const by = new Map(page.rows.map((r) => [r.humanId, r]));
    expect(by.get(subscriber)!.lastActivityAt).toBe(knownSince);
    expect(by.get(user)!.lastActivityAt).toBe("2098-11-10T10:00:00.000Z");
    expect(by.get(reader)!).toMatchObject({ lastActivityAt: "2098-11-12T08:00:00.000Z", lastOursAt: "2098-11-12T08:00:00.000Z", lastTheirsAt: null });
    // Most recent real activity first: the newsletter we sent, the session event, then the scanner-only subscriber.
    expect(page.rows.map((r) => r.humanId)).toEqual([reader, user, subscriber]);

    // The scanner moves no thread and makes no direct conversation; the real session event does.
    const subjects = (await db.execute(sql`
      SELECT human_id::text AS human, has_direct, channels FROM relationship_subjects WHERE org_id = ${orgId}`)) as unknown as Array<{ human: string; has_direct: boolean; channels: string[] }>;
    const subj = new Map(subjects.map((s) => [s.human, s]));
    expect(subj.get(subscriber)).toMatchObject({ has_direct: false, channels: [] });
    expect(subj.get(user)).toMatchObject({ has_direct: true, channels: ["posthog"] });
  });
});
