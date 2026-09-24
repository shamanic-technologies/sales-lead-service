/**
 * An in-memory stand-in for the read model, for route tests that mock `sql` outright.
 *
 * The real model (src/lib/lead-read-model.ts) is rows in Postgres, so a count is a GROUP BY and a
 * page is an ORDER BY ... LIMIT — none of which a `vi.fn()` `sql` compiles. This double keeps the
 * part a route test is about: the rows are DERIVED by the real code (`streamLeadIndex` as the test
 * mocks it, the real `enrichLeadIndex`, the real `attachLeadStandings` with whatever resolver the
 * test mocks, the delivery layer through the test's `checkDeliveryStatus` mock), and the filter,
 * the order and the window are done in JS with the same semantics.
 *
 * What it DOES NOT cover is whether the SQL is right, or the freshness machinery (the change log,
 * the evidence store, the bound): `tests/integration/lead-read-model-sql.test.ts` runs those
 * against a real Postgres.
 */
import { checkDeliveryStatus, type StatusResult } from "../../src/lib/email-gateway-client.js";
import { enrichLeadIndex } from "../../src/lib/lead-engagement.js";
import { streamLeadIndex } from "../../src/lib/lead-index.js";
import { encodeLeadCursor, type LeadListPage } from "../../src/lib/lead-list-query.js";
import type { LeadSortOrder } from "../../src/lib/lead-page-plan.js";
import { attachLeadStandings } from "../../src/lib/lead-standing-index.js";
import { createLeadStandingResolver } from "../../src/lib/lead-standing-resolver.js";
import {
  LEAD_STANDING_STATES,
  zeroStandingCounts,
  type LeadStandingState,
} from "../../src/lib/lead-standing.js";
import { zeroBucketCounts, type LeadBucket } from "../../src/lib/lead-buckets.js";
import type * as RealModule from "../../src/lib/lead-read-model.js";

type Real = typeof RealModule;

interface FakeRow {
  id: string;
  createdAtText: string;
  activityAt: string;
  buckets: Set<LeadBucket>;
  standing: LeadStandingState;
  searchText: string;
}

/** What each built model held, by id — for assertions. */
export const fakeModels = new Map<string, FakeRow[]>();
/** The search tokens every model read was asked for, in order. */
export const fakeModelSearches: Array<readonly string[] | null> = [];

async function gatewayMap(
  scope: RealModule.ReadModelScope,
  statusCampaignId: string | undefined,
  requests: ReadonlyArray<{ brandId: string; email: string }>,
  real: Real,
): Promise<Map<string, StatusResult>> {
  const out = new Map<string, StatusResult>();
  if (!scope.deliveryQueried || requests.length === 0) return out;
  const byBrand = new Map<string, string[]>();
  for (const r of requests) byBrand.set(r.brandId, [...(byBrand.get(r.brandId) ?? []), r.email]);
  for (const [brandId, emails] of byBrand) {
    let response;
    try {
      response = await checkDeliveryStatus(brandId, statusCampaignId, emails.map((email) => ({ email })), {
        orgId: scope.orgId,
      });
    } catch (error) {
      throw new real.ReadModelUnavailableError("email-gateway", (error as Error).message);
    }
    for (const result of response.results) out.set(result.email, result);
  }
  return out;
}

/** The `vi.mock` factory a route test hands `src/lib/lead-read-model.js`. */
export function fakeReadModelModule(real: Real): Real {
  let nextId = 0;

  async function ensureReadModel(scope: RealModule.ReadModelScope): Promise<RealModule.ReadModel> {
    const statusCampaignId = real.statusCampaignIdOf(scope);
    const listScope = {
      orgId: scope.orgId,
      brandId: scope.brandId ?? undefined,
      campaignIds: scope.campaignIds ?? undefined,
      statuses: scope.statuses,
    };
    const resolver = createLeadStandingResolver({
      orgId: scope.orgId,
      userId: null,
      runId: null,
      brandId: scope.brandId,
      deliveryQueried: scope.deliveryQueried,
    });
    const rows: FakeRow[] = [];
    for await (const chunk of streamLeadIndex(listScope, 1000)) {
      const delivery = await gatewayMap(
        scope,
        statusCampaignId,
        chunk
          .filter((r) => r.status === "served" && r.email)
          .map((r) => ({ brandId: r.brandIds[0] ?? "unknown", email: r.email! })),
        real,
      );
      const enriched = await enrichLeadIndex(
        chunk,
        {
          serviceContext: { orgId: scope.orgId },
          statusCampaignId,
          flatten: (result) => real.modelDeliveryFor(scope, "served", result),
          deliveryQueried: scope.deliveryQueried,
          orgId: scope.orgId,
          brandId: scope.brandId ?? undefined,
        },
        true,
        delivery,
      );
      try {
        await attachLeadStandings(enriched, resolver);
      } catch (error) {
        throw new real.ReadModelUnavailableError("standing", (error as Error).message);
      }
      for (const row of enriched) {
        rows.push({
          id: row.id,
          createdAtText: row.createdAtText,
          activityAt: row.activityAt,
          buckets: row.buckets,
          standing: row.standing ?? "unresolved",
          searchText: row.searchText ?? "",
        });
      }
    }
    const id = `model-${nextId++}`;
    fakeModels.set(id, rows);
    return {
      id,
      scopeKey: real.readModelKey(scope),
      orgId: scope.orgId,
      scope,
      evidenceAt: new Date(),
      appliedXmin: "0",
    };
  }

  function filtered(
    model: RealModule.ReadModel,
    tokens: readonly string[] | null,
    bucket: LeadBucket | null,
    standings: readonly LeadStandingState[] | null,
  ): FakeRow[] {
    fakeModelSearches.push(tokens);
    return (fakeModels.get(model.id) ?? []).filter(
      (row) =>
        (tokens ?? []).every((t) => row.searchText.toLowerCase().includes(t.toLowerCase())) &&
        (bucket === null || row.buckets.has(bucket)) &&
        (standings === null || standings.includes(row.standing)),
    );
  }

  return {
    ...real,
    ensureReadModel,
    readModelDelivery: (scope, requests) =>
      gatewayMap(scope, real.statusCampaignIdOf(scope), requests, real),
    readModelBucketCounts: async (model, tokens) => {
      const rows = filtered(model, tokens, null, null);
      const counts = zeroBucketCounts();
      for (const row of rows) for (const b of row.buckets) counts[b] += 1;
      return { total: rows.length, counts };
    },
    readModelStandingCounts: async (model, tokens) => {
      const rows = filtered(model, tokens, null, null);
      const counts = zeroStandingCounts();
      for (const row of rows) {
        const state = LEAD_STANDING_STATES.includes(row.standing) ? row.standing : "unresolved";
        counts[state] += 1;
      }
      return { total: rows.length, counts };
    },
    readModelPage: async (model, query) => {
      const rows = filtered(model, query.tokens, query.bucket, query.standings);
      return pageOf(rows, query.sort, query.page);
    },
  };
}

function pageOf(rows: FakeRow[], sort: LeadSortOrder, page: LeadListPage): RealModule.LeadPlanPage {
  const total = rows.length;
  const ordered = [...rows].sort((a, b) =>
    sort === "created"
      ? a.createdAtText === b.createdAtText
        ? a.id < b.id
          ? -1
          : 1
        : a.createdAtText < b.createdAtText
          ? -1
          : 1
      : a.activityAt === b.activityAt
        ? a.id > b.id
          ? -1
          : 1
        : new Date(a.activityAt).getTime() > new Date(b.activityAt).getTime()
          ? -1
          : 1,
  );
  const position = (row: FakeRow) => (sort === "created" ? row.createdAtText : row.activityAt);
  const cursor = page.cursor;
  const afterCursor = cursor
    ? ordered.filter((row) =>
        sort === "created"
          ? position(row) === cursor.createdAt
            ? row.id > cursor.id
            : position(row) > cursor.createdAt
          : new Date(position(row)).getTime() === new Date(cursor.createdAt).getTime()
            ? row.id < cursor.id
            : new Date(position(row)).getTime() < new Date(cursor.createdAt).getTime(),
      )
    : ordered;
  const start = page.offset !== null && page.offset > 0 ? page.offset : 0;
  const windowed = afterCursor.slice(start);
  const pageRows = page.limit === null ? windowed : windowed.slice(0, page.limit);
  const last = pageRows[pageRows.length - 1];
  const nextCursor =
    page.limit !== null && last && windowed.length > pageRows.length
      ? encodeLeadCursor({ createdAt: position(last), id: last.id })
      : null;
  return {
    total,
    nextCursor,
    async *ids(chunkSize: number) {
      for (let i = 0; i < pageRows.length; i += Math.max(1, chunkSize)) {
        yield pageRows.slice(i, i + Math.max(1, chunkSize)).map((row) => row.id);
      }
    },
  };
}
