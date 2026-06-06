/**
 * ONE-TIME current-employer reconciliation.
 *
 * Why: Apollo enrichment re-asserts "current" on every call without expiring the
 * prior employment, so ~86% of leads accumulated MORE THAN ONE leads_organizations
 * row flagged current=true. The read path (lead-shape.ts pickCurrentEmployment) now
 * picks the right one at serve time, and the write path (leads-registry.ts
 * recordEmploymentHistory) now keeps exactly one current going forward — but the
 * rows that piled up before that fix still carry multiple current=true.
 *
 * What: for every lead, collapse to exactly ONE current=true employment using the
 * SAME winner-selection as the read path — enriched org first (logo_url OR
 * primary_domain non-null), then most-recently-created, then organization_id for a
 * stable tiebreak. All other current=true rows for the lead are set current=false.
 *
 * Properties:
 *   - History-preserving — only flips the `current` flag; never deletes a row.
 *   - Idempotent        — re-running converges (a lead already at one current is
 *                         untouched; the `current <> (rn = 1)` guard skips no-op writes).
 *   - Read-path aligned — same ORDER BY as pickCurrentEmployment, so the backfilled
 *                         state matches what the serve path would have selected.
 *
 * Usage:
 *   LEAD_SERVICE_DATABASE_URL=... npx tsx scripts/backfill-current-employment.ts --dry-run
 *   LEAD_SERVICE_DATABASE_URL=... npx tsx scripts/backfill-current-employment.ts
 */

import { sql as leadSql } from "../src/db/index.js";

export function parseArgs(argv: string[]): { dryRun: boolean } {
  return { dryRun: argv.includes("--dry-run") };
}

/** Count leads that currently carry more than one current=true employment. */
async function countMultiCurrentLeads(): Promise<number> {
  const rows = await leadSql<{ c: string }[]>`
    SELECT count(*)::text AS c FROM (
      SELECT lead_id
      FROM leads_organizations
      WHERE current = true
      GROUP BY lead_id
      HAVING count(*) > 1
    ) t`;
  return Number(rows[0]?.c ?? "0");
}

/**
 * Collapse every lead to one current=true row using the read-path winner-selection.
 * Returns the number of rows whose current flag changed.
 */
async function collapseToOneCurrent(): Promise<number> {
  const changed = await leadSql<{ id: string }[]>`
    WITH ranked AS (
      SELECT lo.id,
        row_number() OVER (
          PARTITION BY lo.lead_id
          ORDER BY
            (CASE WHEN o.logo_url IS NOT NULL OR o.primary_domain IS NOT NULL THEN 0 ELSE 1 END),
            lo.created_at DESC,
            lo.organization_id
        ) AS rn
      FROM leads_organizations lo
      LEFT JOIN organizations o ON o.id = lo.organization_id
      WHERE lo.current = true
    )
    UPDATE leads_organizations lo
    SET current = (ranked.rn = 1)
    FROM ranked
    WHERE lo.id = ranked.id
      AND lo.current <> (ranked.rn = 1)
    RETURNING lo.id`;
  return changed.length;
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs(process.argv.slice(2));
  console.log(`[lead-service] current-employment backfill start dryRun=${dryRun}`);

  try {
    const multi = await countMultiCurrentLeads();
    console.log(`[lead-service] leads with >1 current=true: ${multi}`);

    if (dryRun) {
      console.log("[lead-service] DRY RUN — no writes performed");
      return;
    }

    const changed = await collapseToOneCurrent();
    console.log(`[lead-service] backfill done — flipped current on ${changed} rows`);

    const remaining = await countMultiCurrentLeads();
    if (remaining > 0) {
      console.warn(`[lead-service] WARNING: ${remaining} leads still have >1 current after backfill`);
    } else {
      console.log("[lead-service] verified: every lead now has at most one current=true");
    }
  } finally {
    await leadSql.end();
  }
}

// Only auto-run when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1]?.includes("backfill-current-employment");
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[lead-service] current-employment backfill failed:", err);
    process.exit(1);
  });
}
