/**
 * ONE-TIME historical lead reconciliation.
 *
 * Why: lead-service's `leads_campaigns` membership table only began populating on
 * 2026-05-08 (the Apollo buffer→serve pipeline cutover). Outreach that ran before
 * that date went straight through instantly-service and never created membership
 * rows here, so `GET /orgs/leads?brandId=` returns empty for those brands and
 * features-service computes zero historical revenue.
 *
 * What: reads the instantly-service send log (`instantly_campaigns`, which already
 * carries OUR `campaign_id` + `brand_ids` + `feature_slug` + `workflow_slug` per
 * sent lead) READ-ONLY, and restores the missing lead-set into lead-service:
 *   - `leads`                — stub identity (name only) when the email is unknown here
 *   - `lead_contact_methods` — the email, so the live email-gateway overlay can resolve it
 *   - `leads_campaigns`      — a `status='served'` membership row, backdated to the send time
 *
 * Delivery status (sent / replied / replyClassification) is NOT stored — it stays
 * live from email-gateway `POST /orgs/status`, which already holds the full instantly
 * history keyed by email. We only restore the membership (lead-service's own domain).
 *
 * Properties:
 *   - Idempotent      — `leads_campaigns` insert is `onConflictDoNothing` on
 *                       (lead_id, campaign_id); re-running inserts nothing new.
 *   - Reversible      — every row is tagged: contact `source='instantly-backfill'`,
 *                       membership `status_reason='historical_backfill'`. Undo:
 *                       DELETE FROM leads_campaigns WHERE status_reason='historical_backfill';
 *                       DELETE FROM lead_contact_methods WHERE source='instantly-backfill';
 *                       (stub leads with no other refs can be cleaned up afterwards).
 *   - Feature-scoped  — only rows whose `feature_slug` matches are restored; never the
 *                       brand's whole instantly history.
 *
 * Source coupling: this script reads instantly-service's DB directly via
 * INSTANTLY_DATABASE_URL. That is a deliberate one-time exception to the HTTP-boundary
 * convention — it is throwaway reconciliation tooling, not service code, and the live
 * pipeline (not this script) covers all new campaigns.
 *
 * Usage:
 *   LEAD_SERVICE_DATABASE_URL=... INSTANTLY_DATABASE_URL=... \
 *     npx tsx scripts/backfill-historical-leads.ts --dry-run
 *   LEAD_SERVICE_DATABASE_URL=... INSTANTLY_DATABASE_URL=... \
 *     npx tsx scripts/backfill-historical-leads.ts [--org=<orgId>] [--feature=<slug>]
 */

import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { sql as leadSql, db } from "../src/db/index.js";
import { leads, leadContactMethods, leadsCampaigns } from "../src/db/schema.js";

const DEFAULT_FEATURE = "sales-cold-email-outreach";
const CHUNK = 500;

export interface SourceRow {
  campaignId: string;
  instantlyCampaignId: string | null;
  email: string | null;
  orgId: string;
  brandIds: string[];
  workflowSlug: string | null;
  featureSlug: string | null;
  createdAt: Date;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
}

export interface DedupedPair {
  emailLower: string;
  email: string;
  campaignId: string;
  row: SourceRow;
}

/** Lowercase, trim, treat empty as null. */
function normEmail(email: string | null): string | null {
  if (!email) return null;
  const t = email.trim().toLowerCase();
  return t.length > 0 ? t : null;
}

/**
 * Collapse source rows to one entry per (lowerEmail, campaignId). Rows with no usable
 * email are dropped (can't attach a contact / can't resolve the overlay). First row
 * wins for a given pair (source is ordered by created_at ASC = earliest send).
 */
export function dedupeSourceRows(rows: SourceRow[]): {
  pairs: DedupedPair[];
  distinctEmails: string[];
} {
  const seen = new Set<string>();
  const pairs: DedupedPair[] = [];
  const emails = new Set<string>();
  for (const row of rows) {
    const emailLower = normEmail(row.email);
    if (!emailLower) continue;
    emails.add(emailLower);
    const key = `${emailLower}::${row.campaignId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ emailLower, email: row.email!.trim(), campaignId: row.campaignId, row });
  }
  return { pairs, distinctEmails: Array.from(emails) };
}

/** Stub identity fields for a lead unknown to lead-service. */
export function pickStubLeadFields(row: SourceRow): {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
} {
  const firstName = row.firstName?.trim() || null;
  const lastName = row.lastName?.trim() || null;
  const composed = [firstName, lastName].filter(Boolean).join(" ").trim();
  return { firstName, lastName, name: composed.length > 0 ? composed : null };
}

/** A `leads_campaigns` insert value for a restored historical membership. */
export function buildMembershipValue(pair: DedupedPair, leadId: string) {
  const { row } = pair;
  return {
    leadId,
    campaignId: pair.campaignId,
    orgId: row.orgId,
    brandIds: row.brandIds,
    status: "served" as const,
    statusReason: "historical_backfill",
    statusDetails: `backfilled from instantly_campaigns instantly_campaign_id=${row.instantlyCampaignId ?? "unknown"}`,
    servedAt: row.createdAt,
    workflowSlug: row.workflowSlug ?? null,
    featureSlug: row.featureSlug ?? null,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function parseArgs(argv: string[]): { dryRun: boolean; org: string | null; feature: string } {
  let dryRun = false;
  let org: string | null = null;
  let feature = DEFAULT_FEATURE;
  for (const a of argv) {
    if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--org=")) org = a.slice("--org=".length);
    else if (a.startsWith("--feature=")) feature = a.slice("--feature=".length);
  }
  return { dryRun, org, feature };
}

async function fetchSourceRows(
  instantly: postgres.Sql,
  feature: string,
  org: string | null,
): Promise<SourceRow[]> {
  const rows = org
    ? await instantly`
        SELECT DISTINCT ON (ic.lead_email, ic.campaign_id)
          ic.campaign_id, ic.instantly_campaign_id, ic.lead_email,
          ic.org_id, ic.brand_ids, ic.workflow_slug, ic.feature_slug, ic.created_at,
          il.first_name, il.last_name, il.company_name
        FROM instantly_campaigns ic
        LEFT JOIN instantly_leads il
          ON il.instantly_campaign_id = ic.instantly_campaign_id
         AND lower(il.email) = lower(ic.lead_email)
        WHERE ic.feature_slug = ${feature}
          AND ic.lead_email IS NOT NULL
          AND ic.org_id = ${org}
        ORDER BY ic.lead_email, ic.campaign_id, ic.created_at ASC`
    : await instantly`
        SELECT DISTINCT ON (ic.lead_email, ic.campaign_id)
          ic.campaign_id, ic.instantly_campaign_id, ic.lead_email,
          ic.org_id, ic.brand_ids, ic.workflow_slug, ic.feature_slug, ic.created_at,
          il.first_name, il.last_name, il.company_name
        FROM instantly_campaigns ic
        LEFT JOIN instantly_leads il
          ON il.instantly_campaign_id = ic.instantly_campaign_id
         AND lower(il.email) = lower(ic.lead_email)
        WHERE ic.feature_slug = ${feature}
          AND ic.lead_email IS NOT NULL
        ORDER BY ic.lead_email, ic.campaign_id, ic.created_at ASC`;

  return rows.map((r) => ({
    campaignId: r.campaign_id as string,
    instantlyCampaignId: (r.instantly_campaign_id as string | null) ?? null,
    email: (r.lead_email as string | null) ?? null,
    orgId: r.org_id as string,
    brandIds: (r.brand_ids as string[] | null) ?? [],
    workflowSlug: (r.workflow_slug as string | null) ?? null,
    featureSlug: (r.feature_slug as string | null) ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at : new Date(r.created_at as string),
    firstName: (r.first_name as string | null) ?? null,
    lastName: (r.last_name as string | null) ?? null,
    companyName: (r.company_name as string | null) ?? null,
  }));
}

/** email(lower) -> leadId, for emails already known to lead-service. */
async function resolveExistingLeads(distinctEmails: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const batch of chunk(distinctEmails, CHUNK)) {
    const rows = await leadSql<{ lead_id: string; email_lower: string }[]>`
      SELECT lead_id, lower(value) AS email_lower
      FROM lead_contact_methods
      WHERE channel = 'email' AND lower(value) = ANY(${batch})`;
    for (const r of rows) map.set(r.email_lower, r.lead_id);
  }
  return map;
}

async function main(): Promise<void> {
  const { dryRun, org, feature } = parseArgs(process.argv.slice(2));
  const instantlyUrl = process.env.INSTANTLY_DATABASE_URL;
  if (!instantlyUrl) throw new Error("[lead-service] INSTANTLY_DATABASE_URL is not set");

  const instantly = postgres(instantlyUrl, { prepare: false });
  console.log(
    `[lead-service] backfill start feature=${feature} org=${org ?? "ALL"} dryRun=${dryRun}`,
  );

  try {
    const rows = await fetchSourceRows(instantly, feature, org);
    const { pairs, distinctEmails } = dedupeSourceRows(rows);
    const distinctCampaigns = new Set(pairs.map((p) => p.campaignId));
    const distinctOrgs = new Set(rows.map((r) => r.orgId));
    console.log(
      `[lead-service] source rows=${rows.length} pairs(email,campaign)=${pairs.length} ` +
        `distinctEmails=${distinctEmails.length} campaigns=${distinctCampaigns.size} orgs=${distinctOrgs.size}`,
    );

    const existing = await resolveExistingLeads(distinctEmails);
    const missingEmails = distinctEmails.filter((e) => !existing.has(e));
    const alreadyBackfilled = await leadSql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM leads_campaigns WHERE status_reason = 'historical_backfill'`;
    console.log(
      `[lead-service] emails: existing=${existing.size} missing=${missingEmails.length} | ` +
        `leads_campaigns already historical_backfill=${alreadyBackfilled[0]?.c ?? "0"}`,
    );

    if (dryRun) {
      console.log(
        `[lead-service] DRY RUN — would create up to ${missingEmails.length} stub leads, ` +
          `attach ${missingEmails.length} emails, and insert up to ${pairs.length} membership rows ` +
          `(existing (lead,campaign) memberships are skipped via onConflictDoNothing). No writes performed.`,
      );
      return;
    }

    // Phase 1 — create stub leads + emails for unknown recipients. Client-side UUIDs
    // give us the email→leadId mapping without relying on INSERT...RETURNING ordering.
    const leadRows: { id: string; firstName: string | null; lastName: string | null; name: string | null }[] = [];
    const cmRows: { leadId: string; channel: string; value: string; status: string | null; source: string }[] = [];
    const firstRowByEmail = new Map<string, SourceRow>();
    for (const p of pairs) if (!firstRowByEmail.has(p.emailLower)) firstRowByEmail.set(p.emailLower, p.row);

    for (const emailLower of missingEmails) {
      const row = firstRowByEmail.get(emailLower)!;
      const id = randomUUID();
      leadRows.push({ id, ...pickStubLeadFields(row) });
      cmRows.push({ leadId: id, channel: "email", value: row.email!.trim(), status: null, source: "instantly-backfill" });
      existing.set(emailLower, id);
    }

    let leadsInserted = 0;
    for (const c of chunk(leadRows, CHUNK)) {
      if (c.length === 0) continue;
      await db.insert(leads).values(c);
      leadsInserted += c.length;
    }
    let emailsAttached = 0;
    for (const c of chunk(cmRows, CHUNK)) {
      if (c.length === 0) continue;
      const res = await db.insert(leadContactMethods).values(c).onConflictDoNothing().returning({ id: leadContactMethods.id });
      emailsAttached += res.length;
    }
    console.log(`[lead-service] phase1 stubLeads=${leadsInserted} emailsAttached=${emailsAttached}`);

    // Phase 2 — restore memberships. Skip pairs whose email never resolved (defensive).
    const memberships = pairs
      .map((p) => {
        const leadId = existing.get(p.emailLower);
        return leadId ? buildMembershipValue(p, leadId) : null;
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    let membershipsInserted = 0;
    for (const c of chunk(memberships, CHUNK)) {
      if (c.length === 0) continue;
      const res = await db
        .insert(leadsCampaigns)
        .values(c)
        .onConflictDoNothing({ target: [leadsCampaigns.leadId, leadsCampaigns.campaignId] })
        .returning({ id: leadsCampaigns.id });
      membershipsInserted += res.length;
    }
    console.log(
      `[lead-service] phase2 membershipsConsidered=${memberships.length} inserted=${membershipsInserted} ` +
        `skippedExisting=${memberships.length - membershipsInserted}`,
    );
    console.log("[lead-service] backfill done");
  } finally {
    await instantly.end();
    await leadSql.end();
  }
}

// Only auto-run when invoked directly (not when imported by tests).
const invokedDirectly = process.argv[1]?.includes("backfill-historical-leads");
if (invokedDirectly) {
  main().catch((err) => {
    console.error("[lead-service] backfill failed:", err);
    process.exit(1);
  });
}
