/**
 * Moves everything this service holds for ONE brand from one org to another — the lead-service
 * half of brand-service's `POST /orgs/brands/:brandId/transfer`, which fans the LOCKED fleet
 * contract `POST /internal/transfer-brand` out to every service registering it.
 *
 * What moves is HISTORY: every row that ties the brand (directly, or through a campaign of the
 * brand) to the source org is re-keyed onto the target org, and its brand id is rewritten to
 * `targetBrandId` when one is given. Nothing is copied and nothing is deleted except DERIVED
 * state this service rebuilds on its own (read models, change feeds — a read rebuilds them
 * under the new org), so after a transfer the source org holds nothing of the brand.
 *
 * Four things are load-bearing.
 * (1) ONE transaction. Either every table moves or none does — a half-moved brand would show a
 *     lead list under one org and its outcomes under another.
 * (2) Idempotent by construction, not by a cache: every statement selects only rows still on the
 *     SOURCE side (or, for a brand rewrite, rows still carrying the source brand), so a second
 *     call finds nothing and reports zero everywhere. The caller (brand-service) sends no run id,
 *     so an `x-run-id`-keyed replay cache — what this route used to rely on — cannot be the
 *     mechanism.
 * (3) A row shared with ANOTHER brand (`brand_ids` holding several ids) cannot be split between
 *     two orgs, and leaving it behind would break "the source org holds nothing of the brand".
 *     So its presence REFUSES the transfer before anything is written (`SharedBrandRowsError`),
 *     rather than being silently skipped as the April 2026 version did.
 * (4) A rewrite onto `targetBrandId` can collide with a unique index keyed on the brand (the
 *     brand's conversion token, a statement's dedupe signature). The conversion token is the
 *     one expected collision — the target brand may already carry a freshly minted token — and
 *     the SOURCE token wins, because it is the one installed on the client's website. Any other
 *     collision aborts the transaction loudly.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

export interface BrandTransferInput {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
}

export interface TransferredTable {
  tableName: string;
  count: number;
}

export class SharedBrandRowsError extends Error {
  constructor(public readonly shared: TransferredTable[]) {
    super(
      `brand is shared with another brand on ${shared
        .map((s) => `${s.count} ${s.tableName} row(s)`)
        .join(", ")}; such rows cannot be split between two orgs`,
    );
    this.name = "SharedBrandRowsError";
  }
}

type Executor = Pick<typeof db, "execute">;

async function count(ex: Executor, query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await ex.execute(query)) as unknown as Array<{ n: number | string }>;
  return Number(rows[0]?.n ?? 0);
}

export async function transferBrand(input: BrandTransferInput): Promise<TransferredTable[]> {
  const { sourceBrandId: src, sourceOrgId: fromOrg, targetOrgId: toOrg } = input;
  // A rewrite onto the same id is no rewrite at all.
  const toBrand =
    input.targetBrandId && input.targetBrandId !== src ? input.targetBrandId : null;
  // The brand id every moved row ends up carrying.
  const finalBrand = toBrand ?? src;

  return db.transaction(async (tx) => {
    // --- (3) refuse a brand that shares rows with another brand -----------------------------
    const shared: TransferredTable[] = [];
    for (const table of ["leads_campaigns", "followup_actions", "requeued_serves"]) {
      const n = await count(
        tx,
        sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)}
            WHERE org_id = ${fromOrg}
              AND ${src} = ANY(brand_ids)
              AND array_length(brand_ids, 1) > 1`,
      );
      if (n > 0) shared.push({ tableName: table, count: n });
    }
    if (shared.length > 0) throw new SharedBrandRowsError(shared);

    const moved: TransferredTable[] = [];

    // Rows are "still to move" when they sit on the source org, or — when the brand is rewritten
    // — when they already sit on the target org but still carry the source brand id.
    const brandScalarPending = toBrand
      ? sql`brand_id = ${src} AND org_id IN (${fromOrg}, ${toOrg})`
      : sql`brand_id = ${src} AND org_id = ${fromOrg}`;
    const brandArrayPending = toBrand
      ? sql`brand_ids = ARRAY[${src}]::text[] AND org_id IN (${fromOrg}, ${toOrg})`
      : sql`brand_ids = ARRAY[${src}]::text[] AND org_id = ${fromOrg}`;

    // --- campaigns of the brand (read BEFORE leads_campaigns moves) --------------------------
    // campaigns_apollo_strategies carries no brand; it belongs to the brand through its campaign.
    const campaignRows = (await tx.execute(sql`
      SELECT DISTINCT campaign_id FROM leads_campaigns WHERE ${brandArrayPending}
      UNION SELECT DISTINCT campaign_id FROM requeued_serves WHERE ${brandArrayPending}
      UNION SELECT DISTINCT held_by_campaign_id FROM followup_actions WHERE ${brandArrayPending}
      UNION SELECT DISTINCT acting_campaign_id FROM followup_actions
            WHERE ${brandArrayPending} AND acting_campaign_id IS NOT NULL
      UNION SELECT DISTINCT campaign_id FROM lead_step_disqualifications WHERE ${brandScalarPending}
      UNION SELECT DISTINCT campaign_id FROM conversion_events
            WHERE ${brandScalarPending} AND campaign_id IS NOT NULL
    `)) as unknown as Array<{ campaign_id: string }>;
    const campaignIds = campaignRows.map((r) => r.campaign_id);

    // --- array-keyed tables -------------------------------------------------------------------
    moved.push({
      tableName: "leads_campaigns",
      count: await count(
        tx,
        sql`WITH m AS (
              UPDATE leads_campaigns
              SET org_id = ${toOrg}, brand_ids = ARRAY[${finalBrand}]::text[], updated_at = now()
              WHERE ${brandArrayPending}
              RETURNING 1)
            SELECT count(*)::int AS n FROM m`,
      ),
    });
    moved.push({
      tableName: "followup_actions",
      count: await count(
        tx,
        sql`WITH m AS (
              UPDATE followup_actions
              SET org_id = ${toOrg}, brand_ids = ARRAY[${finalBrand}]::text[]
              WHERE ${brandArrayPending}
              RETURNING 1)
            SELECT count(*)::int AS n FROM m`,
      ),
    });
    // The snapshot is what a reversal restores from, so it must name the org the row now lives in.
    moved.push({
      tableName: "requeued_serves",
      count: await count(
        tx,
        sql`WITH m AS (
              UPDATE requeued_serves
              SET org_id = ${toOrg},
                  brand_ids = ARRAY[${finalBrand}]::text[],
                  row_snapshot = row_snapshot
                    || jsonb_build_object('org_id', ${toOrg}::text,
                                          'brand_ids', jsonb_build_array(${finalBrand}::text))
              WHERE ${brandArrayPending}
              RETURNING 1)
            SELECT count(*)::int AS n FROM m`,
      ),
    });

    // --- campaign-keyed table -----------------------------------------------------------------
    moved.push({
      tableName: "campaigns_apollo_strategies",
      count:
        campaignIds.length === 0
          ? 0
          : await count(
              tx,
              sql`WITH m AS (
                    UPDATE campaigns_apollo_strategies
                    SET org_id = ${toOrg}, updated_at = now()
                    WHERE org_id = ${fromOrg}
                      AND campaign_id = ANY(${sql.param(campaignIds)}::text[])
                    RETURNING 1)
                  SELECT count(*)::int AS n FROM m`,
            ),
    });

    // --- the brand's conversion token (4): the source token is the one on the live website ---
    if (toBrand) {
      await tx.execute(sql`
        DELETE FROM brand_conversion_tokens
        WHERE brand_id = ${toBrand}
          AND EXISTS (SELECT 1 FROM brand_conversion_tokens s WHERE s.brand_id = ${src}
                      AND s.org_id IN (${fromOrg}, ${toOrg}))
      `);
    }

    // --- scalar brand-keyed tables ------------------------------------------------------------
    const scalarTables: Array<{ table: string; touchesUpdatedAt: boolean }> = [
      { table: "brand_conversion_tokens", touchesUpdatedAt: true },
      { table: "conversion_events", touchesUpdatedAt: false },
      { table: "lead_step_disqualifications", touchesUpdatedAt: true },
      { table: "lead_step_cause_statements", touchesUpdatedAt: true },
      { table: "crm_pairing_matches", touchesUpdatedAt: false },
      { table: "crm_pairing_judgments", touchesUpdatedAt: false },
      { table: "crm_pairing_rulings", touchesUpdatedAt: true },
      { table: "qualification_criteria", touchesUpdatedAt: false },
      { table: "qualification_checks", touchesUpdatedAt: false },
      { table: "candidate_screenings", touchesUpdatedAt: false },
    ];
    for (const { table, touchesUpdatedAt } of scalarTables) {
      moved.push({
        tableName: table,
        count: await count(
          tx,
          sql`WITH m AS (
                UPDATE ${sql.identifier(table)}
                SET org_id = ${toOrg}, brand_id = ${finalBrand}
                    ${touchesUpdatedAt ? sql`, updated_at = now()` : sql.empty()}
                WHERE ${brandScalarPending}
                RETURNING 1)
              SELECT count(*)::int AS n FROM m`,
        ),
      });
    }

    // --- delivery evidence: a cache keyed like the gateway question -------------------------
    // Move every answer; an answer the target already holds for the same key is the fresher
    // one, so the source copy is dropped rather than overwriting it.
    await tx.execute(sql`
      DELETE FROM lead_delivery_evidence s
      WHERE ${brandScalarPending}
        AND EXISTS (SELECT 1 FROM lead_delivery_evidence t
                    WHERE t.org_id = ${toOrg} AND t.brand_id = ${finalBrand}
                      AND t.campaign_id = s.campaign_id AND t.email = s.email)
    `);
    moved.push({
      tableName: "lead_delivery_evidence",
      count: await count(
        tx,
        sql`WITH m AS (
              UPDATE lead_delivery_evidence
              SET org_id = ${toOrg}, brand_id = ${finalBrand}
              WHERE ${brandScalarPending}
              RETURNING 1)
            SELECT count(*)::int AS n FROM m`,
      ),
    });

    // --- derived state: dropped, rebuilt by the next read under the new org ------------------
    // A model/feed is a projection of the rows above keyed on (org, scope). One scoped to this
    // brand — or to the whole org, which included it — describes rows that no longer live there.
    // Only when something actually moved: a re-run must touch nothing (2).
    const anythingMoved = moved.some((m) => m.count > 0);
    for (const table of ["lead_read_models", "lead_change_feeds"]) {
      moved.push({
        tableName: table,
        count: !anythingMoved ? 0 : await count(
          tx,
          sql`WITH m AS (
                DELETE FROM ${sql.identifier(table)}
                WHERE org_id IN (${fromOrg}, ${toOrg})
                  AND (scope->>'brandId' IS NULL
                       OR scope->>'brandId' IN (${src}, ${finalBrand}))
                RETURNING 1)
              SELECT count(*)::int AS n FROM m`,
        ),
      });
    }

    return moved;
  });
}
