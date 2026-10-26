/**
 * JOURNALISTS ARE NOT LEADS (JOURNALISTS-NOT-LEADS-1016, owner 2026-10-16: "il faut les tagger differemment que lead,
 * mais journalists dans le backend. Ce ne sont pas des leads"). A brand never sells to a journalist.
 *
 * Incident 2026-10-14: the Lead Sourcing pipe of "Cold Follow-up Replies" (Distribute.you) re-served the brand's
 * contacted people to an AI Follow-up Email pipe; 8 of them had only ever been pitched by the June PR campaigns
 * (Forbes, TechCrunch, Indie Hackers journalists), got sales follow-ups, and 4 bounced.
 *
 * `journalist` is a relationship tag (relationship-tags.ts, lead level), decided like every tag, person > evidence >
 * judgment:
 *   - a person of the org said yes / no (review page, MCP);
 *   - EVIDENCE: the brand reached the lead ONLY through a press pitch (`press_only`): a `leads_campaigns` row of the
 *     brand on a PRESS channel (features-service catalogue `channelType: "pr"`) and no sales history at the brand,
 *     i.e. no row on a SALES channel (`channelType: "outbound"`) and no prospect / customer evidence (signup, form,
 *     meeting, payment, won sale). Sourcing and conversion pipes (lead-sourcing, ai-follow-up-email...) only re-work
 *     people found elsewhere: they never turn a journalist into a lead (the incident's own rows would otherwise
 *     launder them). Pitched AND cold-sold (or signed up, met, paid) = still a lead unless a person or Jev says
 *     journalist (owner's reading, brief 2026-10-16);
 *   - Jev's judgment (relationship-judge.ts asks "is this person a journalist?").
 *
 * The decided answer is MATERIALIZED per (org, brand, lead) in `brand_journalists` (migration 0099) so every serve
 * path refuses it in SQL: every pool (reach-sql.ts `journalistClause`, through `reachClauses`), the fresh serve
 * (buffer.ts, checked right after filing), the named serve, the follow-up claim and its owed read. lead-service is the
 * SALES lead service (press lives in journalists-service), so the refusal holds for every pipe that asks here.
 * Rewritten fleet-wide by the background thread every `BRAND_JOURNALISTS_INTERVAL_MS` (and for one brand right after a
 * person states the tag); a row nobody speaks about any more is deleted.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { FEATURES_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { JUDGED_YES } from "./relationship-tags.js";

export const JOURNALIST_TAG = "journalist" as const;
/** The evidence word a press-only lead carries on its tag detail. */
export const PRESS_ONLY_EVIDENCE = "press_pitch_only";
/** features-service `channelType` of a press channel / of a sales channel. */
export const PRESS_CHANNEL_TYPE = "pr";
export const SALES_CHANNEL_TYPE = "outbound";

export const BRAND_JOURNALISTS_INTERVAL_MS = 5 * 60_000;
const FIRST_DELAY_MS = 60_000;
const CATALOGUE_TTL_MS = 5 * 60_000;
const CATALOGUE_TIMEOUT_MS = 15_000;

export interface ChannelKinds {
  press: string[];
  sales: string[];
}

/** PURE. Press and sales channel slugs of a `/public/channels` body. THROWS on an unreadable list or no press channel. */
export function parseChannelKinds(body: unknown): ChannelKinds {
  const channels = (body as { channels?: unknown } | null)?.channels;
  if (!Array.isArray(channels)) throw new Error("features-service /public/channels answered without a channels array");
  const press: string[] = [];
  const sales: string[] = [];
  for (const c of channels as Array<{ slug?: unknown; channelType?: unknown }>) {
    if (typeof c?.slug !== "string") continue;
    if (c.channelType === PRESS_CHANNEL_TYPE) press.push(c.slug);
    if (c.channelType === SALES_CHANNEL_TYPE) sales.push(c.slug);
  }
  // A catalogue naming no press channel cannot say who was pitched: never read as "nobody is a journalist".
  if (press.length === 0) throw new Error("features-service /public/channels names no press channel (channelType pr)");
  return { press: press.sort(), sales: sales.sort() };
}

let kindsCache: { at: number; kinds: ChannelKinds } | null = null;

/** Test hook. */
export function resetChannelKinds(): void {
  kindsCache = null;
}

export async function loadChannelKinds(): Promise<ChannelKinds> {
  if (kindsCache && Date.now() - kindsCache.at < CATALOGUE_TTL_MS) return kindsCache.kinds;
  const response = await fetchWithRetry(`${FEATURES_SERVICE_URL}/public/channels`, { signal: AbortSignal.timeout(CATALOGUE_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`features-service /public/channels failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  const kinds = parseChannelKinds(await response.json());
  kindsCache = { at: Date.now(), kinds };
  return kinds;
}

/** The scope a pool hands out for: the org and the brand(s) (a `text[]` SQL expression). */
export interface JournalistScope {
  orgId: SQL;
  brandIds: SQL;
}

export function journalistScopeOf(orgId: string, brandIds: readonly string[]): JournalistScope {
  return { orgId: sql`${orgId}`, brandIds: sql`${sql.param([...brandIds])}::text[]` };
}

/** `AND NOT EXISTS (...)`: the lead is no journalist of the scope's brand(s). Every sales pool carries it. */
export function journalistClause(leadId: SQL, scope: JournalistScope): SQL {
  return sql`AND NOT EXISTS (
    SELECT 1 FROM brand_journalists bj_j
    WHERE bj_j.lead_id = ${leadId} AND bj_j.journalist AND bj_j.org_id = ${scope.orgId} AND bj_j.brand_id = ANY(${scope.brandIds}))`;
}

/** Is this lead a journalist of any of these brands of the org? */
export async function leadIsJournalist(leadId: string, orgId: string, brandIds: readonly string[]): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM brand_journalists
    WHERE lead_id = ${leadId}::uuid AND journalist AND org_id = ${orgId} AND brand_id = ANY(${sql.param([...brandIds])}::text[])
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** The org's canonical human of a lead (`leads` alias given): judgment links fold atomic humans. */
export function canonicalHumanSql(orgId: SQL, lead: string): SQL {
  return sql`COALESCE((SELECT o.human_id FROM org_human_aliases o WHERE o.org_id = ${orgId} AND o.atomic_human_id = ${sql.raw(lead)}.human_id), ${sql.raw(lead)}.human_id)`;
}

export interface RefreshResult {
  journalists: number;
  pressOnly: number;
  written: number;
  deleted: number;
}

/**
 * Rewrite `brand_journalists` for the whole fleet, or one (org, brand). ONE statement: candidates = every lead the
 * brand pitched to the press, plus every lead of a human a person or Jev speaks about as a journalist of the brand.
 */
export async function refreshBrandJournalists(scope?: { orgId: string; brandId: string }): Promise<RefreshResult> {
  const kinds = await loadChannelKinds();
  const press = sql`${sql.param(kinds.press)}::text[]`;
  const sales = sql`${sql.param(kinds.sales.length > 0 ? kinds.sales : ["-"])}::text[]`;
  const inScope = (org: string, brand: string) =>
    scope ? sql`AND ${sql.raw(org)} = ${scope.orgId} AND ${sql.raw(brand)} = ${scope.brandId}` : sql``;
  const rows = (await db.execute(sql`
    WITH pitched AS (
      SELECT DISTINCT lc.org_id, b.brand_id, lc.lead_id
      FROM leads_campaigns lc CROSS JOIN LATERAL unnest(lc.brand_ids) AS b(brand_id)
      WHERE lc.feature_slug = ANY(${press}) ${inScope("lc.org_id", "b.brand_id")}
    ), spoken_humans AS (
      -- Humans a person or Jev speaks about as a journalist of the brand.
      SELECT s.org_id, s.brand_id, s.human_id FROM relationship_statements s
      WHERE s.tag = ${JOURNALIST_TAG} AND s.withdrawn_at IS NULL ${inScope("s.org_id", "s.brand_id")}
      UNION
      SELECT j.org_id, j.brand_id, j.human_id FROM relationship_judgments j
      WHERE (j.probabilities->>${JOURNALIST_TAG})::float8 >= ${JUDGED_YES} ${inScope("j.org_id", "j.brand_id")}
    ), spoken AS (
      -- Every lead of theirs (the human itself, or an atomic human the org folded into it) worked at the brand.
      -- The human's ids are listed first, then joined on the leads index (BOX-OVERLOAD-1026): an OR join on leads ran
      -- a seq scan of leads per spoken human with a correlated org_human_aliases scan per (human, lead) pair, ~240k
      -- subplan scans per refresh, the service's largest Postgres cost.
      SELECT DISTINCT sh.org_id, sh.brand_id, l.id AS lead_id
      FROM spoken_humans sh
      CROSS JOIN LATERAL (
        SELECT sh.human_id AS hid
        UNION
        SELECT o.atomic_human_id FROM org_human_aliases o WHERE o.org_id = sh.org_id AND o.human_id = sh.human_id
      ) hs
      JOIN leads l ON l.human_id = hs.hid
      WHERE EXISTS (SELECT 1 FROM leads_campaigns x WHERE x.lead_id = l.id AND x.org_id = sh.org_id AND sh.brand_id = ANY(x.brand_ids))
    ), candidates AS (
      SELECT org_id, brand_id, lead_id FROM pitched UNION SELECT org_id, brand_id, lead_id FROM spoken
    ), facts AS (
      SELECT c.org_id, c.brand_id, c.lead_id, h.human_id,
        r.pitched, r.sold, r.first_pitched_at, COALESCE(r.pitch_campaign_ids, '{}') AS pitch_campaign_ids,
        EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.org_id = c.org_id AND e.brand_id = c.brand_id
          AND e.human_id = h.human_id AND e.tag IN ('prospect', 'customer')) AS sales_evidence,
        (SELECT s.state FROM relationship_statements s WHERE s.org_id = c.org_id AND s.brand_id = c.brand_id
          AND s.human_id = h.human_id AND s.tag = ${JOURNALIST_TAG} AND s.withdrawn_at IS NULL
          ORDER BY s.stated_at DESC LIMIT 1) AS stated,
        (SELECT max((j.probabilities->>${JOURNALIST_TAG})::float8) FROM relationship_judgments j
          WHERE j.org_id = c.org_id AND j.brand_id = c.brand_id AND j.human_id = h.human_id) AS judged
      FROM candidates c
      JOIN leads l ON l.id = c.lead_id
      CROSS JOIN LATERAL (SELECT ${canonicalHumanSql(sql`c.org_id`, "l")} AS human_id) h
      CROSS JOIN LATERAL (
        SELECT bool_or(x.feature_slug = ANY(${press})) AS pitched,
               bool_or(x.feature_slug = ANY(${sales})) AS sold,
               min(COALESCE(x.served_at, x.created_at)) FILTER (WHERE x.feature_slug = ANY(${press})) AS first_pitched_at,
               array_agg(DISTINCT x.campaign_id) FILTER (WHERE x.feature_slug = ANY(${press})) AS pitch_campaign_ids
        FROM leads_campaigns x
        WHERE x.lead_id = c.lead_id AND x.org_id = c.org_id AND c.brand_id = ANY(x.brand_ids)
      ) r
    ), decided AS (
      SELECT org_id, brand_id, lead_id, first_pitched_at, pitch_campaign_ids,
        (COALESCE(pitched, false) AND NOT COALESCE(sold, false) AND NOT sales_evidence) AS press_only,
        stated, judged
      FROM facts
    ), final AS (
      SELECT org_id, brand_id, lead_id, first_pitched_at, pitch_campaign_ids, press_only,
        CASE WHEN stated = 'yes' THEN true WHEN stated = 'no' THEN false
             WHEN press_only THEN true WHEN judged >= ${JUDGED_YES} THEN true ELSE false END AS journalist,
        CASE WHEN stated IS NOT NULL THEN 'person' WHEN press_only THEN 'press_only'
             WHEN judged >= ${JUDGED_YES} THEN 'judgment' ELSE NULL END AS basis
      FROM decided
      WHERE press_only OR stated IS NOT NULL OR judged >= ${JUDGED_YES}
    ), del AS (
      DELETE FROM brand_journalists t
      WHERE TRUE ${inScope("t.org_id", "t.brand_id")}
        AND NOT EXISTS (SELECT 1 FROM final f WHERE f.org_id = t.org_id AND f.brand_id = t.brand_id AND f.lead_id = t.lead_id)
      RETURNING 1
    ), up AS (
      INSERT INTO brand_journalists (org_id, brand_id, lead_id, press_only, journalist, basis, first_pitched_at, pitch_campaign_ids, updated_at)
      SELECT org_id, brand_id, lead_id, press_only, journalist, basis, first_pitched_at, pitch_campaign_ids, now() FROM final
      ON CONFLICT (org_id, brand_id, lead_id) DO UPDATE SET
        press_only = excluded.press_only, journalist = excluded.journalist, basis = excluded.basis,
        first_pitched_at = excluded.first_pitched_at, pitch_campaign_ids = excluded.pitch_campaign_ids, updated_at = now()
      WHERE (brand_journalists.press_only, brand_journalists.journalist, brand_journalists.basis,
             brand_journalists.first_pitched_at, brand_journalists.pitch_campaign_ids)
        IS DISTINCT FROM (excluded.press_only, excluded.journalist, excluded.basis, excluded.first_pitched_at, excluded.pitch_campaign_ids)
      RETURNING 1
    )
    SELECT
      (SELECT count(*) FROM final WHERE journalist)::int AS journalists,
      (SELECT count(*) FROM final WHERE press_only)::int AS press_only,
      (SELECT count(*) FROM up)::int AS written,
      (SELECT count(*) FROM del)::int AS deleted
  `)) as unknown as Array<{ journalists: number; press_only: number; written: number; deleted: number }>;
  const r = rows[0];
  return { journalists: Number(r?.journalists ?? 0), pressOnly: Number(r?.press_only ?? 0), written: Number(r?.written ?? 0), deleted: Number(r?.deleted ?? 0) };
}

let refreshing = false;

export function startBrandJournalistsWorker(): void {
  const tick = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const r = await refreshBrandJournalists();
      if (r.written || r.deleted) console.log(`[lead-service] brand journalists: ${r.journalists} journalists (${r.pressOnly} press-only), ${r.written} written, ${r.deleted} deleted`);
    } catch (err) {
      console.error("[lead-service] brand journalists refresh failed:", err);
    } finally {
      refreshing = false;
    }
  };
  setTimeout(() => void tick(), FIRST_DELAY_MS).unref();
  setInterval(() => void tick(), BRAND_JOURNALISTS_INTERVAL_MS).unref();
}
