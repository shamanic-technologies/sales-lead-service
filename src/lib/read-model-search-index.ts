/**
 * The trigram index the Leads search reads (`?q=`), built AFTER boot, never in a migration.
 *
 * A search is `search_text ILIKE '%token%'` over one read model (lead-read-model.ts `modelFilter`).
 * No btree can answer a substring, so before this index the planner either filtered every row of
 * the model or, ordering by activity under a LIMIT, ran a PARALLEL SEQ SCAN of the whole table
 * (all models of all orgs, 762k rows): 1.9-2.8s per page statement on an idle box, up to 15s under
 * load, and the single most sampled lead-service query in pg_stat_activity (DASH-LATENCY-1014).
 * With `gin (search_text gin_trgm_ops)` the same page reads ~1.5k candidate rows: 16ms, and a token
 * nobody matches 0.1ms. A token too short to hold a trigram (1-2 letters) is planned on the model's
 * own btree as before. Results are unchanged: the index only proposes candidates and the `ILIKE`
 * is rechecked on every one of them.
 *
 * Why not a migration: migrations run behind the readiness gate (every route 503s until they
 * finish), drizzle wraps them in a transaction (which `CONCURRENTLY` refuses), and a plain
 * `CREATE INDEX` locks the table against the read-model writers for the whole build (~40s+). So the
 * migration only installs the extension (0090) and this runs on the background thread once boot is
 * done: `CREATE INDEX CONCURRENTLY` on its own connection with no statement timeout, under a
 * session advisory lock so two processes (a deploy's overlap) never build it twice. A build killed
 * halfway (container restart) leaves an INVALID index; the next boot drops and rebuilds it.
 */
import postgres from "postgres";

export const SEARCH_INDEX_NAME = "idx_lrmr_search_trgm";
/** Session advisory lock key for the build (arbitrary, stable, used nowhere else). */
const BUILD_LOCK_KEY = "7290519146308441017";

export type SearchIndexOutcome = "present" | "built" | "rebuilt" | "busy";

/** One index built after boot: its name, what it indexes, and the advisory lock key of its build (unique per index). */
export interface PostBootIndex {
  name: string;
  /** `ON <table> ...` (everything after the index name). */
  on: string;
  lockKey: string;
  log: string;
}

const SEARCH_INDEX: PostBootIndex = {
  name: SEARCH_INDEX_NAME,
  on: "ON lead_read_model_rows USING gin (search_text gin_trgm_ops)",
  lockKey: BUILD_LOCK_KEY,
  log: "[lead-read-model] search index",
};

/**
 * Which relation keys crm-service identified, asked per brand by the relationship sweep every tick
 * (crm-lead-identified.ts `crmIdentifiedAmong`, LEDGER-RESIDUAL-1025): without it the read scanned every relation fact
 * of the brand (139,828 on the largest, 26 s). Same reason as the search index to build it here: the table is ~1 GB.
 */
export const RELATION_KEY_INDEX: PostBootIndex = {
  name: "idx_crm_registry_facts_relation_key",
  on: "ON crm_registry_facts (org_id, brand_id, (payload->>'relationKey')) WHERE type = 'relation'",
  lockKey: "7290519146308441018",
  log: "[lead-service] crm relation-key index",
};

/**
 * The indexes the background sweeps' and standing reads' hottest statements need (BOX-OVERLOAD-1026, ranked by sampling
 * prod `pg_stat_activity` and `pg_stat_user_tables` deltas). Built one after the other after boot, like the two above:
 * several tables are hundreds of MB, and a plain `CREATE INDEX` in a migration would lock their writers.
 */
export const LOAD_INDEXES: readonly PostBootIndex[] = [
  {
    // brand-journalists `spoken` and the relationship read's merge lookup: "the atomic humans an org folded into H".
    name: "idx_org_human_aliases_human",
    on: "ON org_human_aliases (org_id, human_id)",
    lockKey: "7290519146308441019",
    log: "[lead-service] load index",
  },
  {
    // brand-journalists `pitched`: the rows of press channels, fleet-wide every 5 min (was a full scan).
    name: "idx_lc_feature_slug",
    on: "ON leads_campaigns (feature_slug)",
    lockKey: "7290519146308441020",
    log: "[lead-service] load index",
  },
  {
    // The follow-up dates intake between two full passes: rows filed since the last pass.
    name: "idx_lc_created_at",
    on: "ON leads_campaigns (created_at)",
    lockKey: "7290519146308441021",
    log: "[lead-service] load index",
  },
  {
    // Identity sweep pass 1, every minute: employers never resolved (was a full scan of ~540 MB).
    name: "idx_organizations_company_unresolved",
    on: "ON organizations (id) WHERE company_resolved_at IS NULL",
    lockKey: "7290519146308441022",
    log: "[lead-service] load index",
  },
  {
    // Identity sweep pass 2, every minute: resolved employers whose row changed since its facts were written.
    name: "idx_organizations_facts_unpushed",
    on: "ON organizations (id) WHERE company_id IS NOT NULL AND (company_facts_pushed_at IS NULL OR updated_at > company_facts_pushed_at)",
    lockKey: "7290519146308441023",
    log: "[lead-service] load index",
  },
  {
    // crm-cold-eligibility `crmPairedOrgs`: the orgs of one brand's CRM facts (every other index leads with org).
    name: "idx_crm_facts_brand_org",
    on: "ON crm_facts (brand_id, org_id)",
    lockKey: "7290519146308441024",
    log: "[lead-service] load index",
  },
  {
    // relationship-read: a human's connection tags (the org-only prefix scanned every registry fact of the org).
    name: "idx_crm_registry_facts_tag_human",
    on: "ON crm_registry_facts (org_id, (raw->>'humanId')) WHERE type = 'connection_tag'",
    lockKey: "7290519146308441025",
    log: "[lead-service] load index",
  },
  {
    // their-acts `not_brand_conversations`: connection tags with a conversation basis (2.2k of 181k), every 2-min
    // pass per scope (was a parallel seq scan of ~800 MB on the largest scope, BOX-DB-LOAD-1027).
    name: "idx_crm_registry_facts_conversation_tags",
    on: `ON crm_registry_facts (org_id, brand_id) WHERE type = 'connection_tag' AND payload->'basis' @> '[{"kind": "conversation"}]'`,
    lockKey: "7290519146308441027",
    log: "[lead-service] load index",
  },
  {
    // their-acts `actScopes`: the scopes whose dates carry an act.
    name: "idx_lfd_last_action_scope",
    on: "ON lead_followup_dates (org_id, brand_id) WHERE last_action_at IS NOT NULL",
    lockKey: "7290519146308441026",
    log: "[lead-service] load index",
  },
];

/**
 * Make sure the search index exists and is VALID. Idempotent; safe to call on every boot.
 * Throws on a database error (the caller logs it; a missing index slows search, it breaks nothing).
 */
export async function ensureReadModelSearchIndex(connectionString: string): Promise<SearchIndexOutcome> {
  return ensurePostBootIndex(connectionString, SEARCH_INDEX);
}

/** The same build for any post-boot index (CONCURRENTLY, own connection, advisory lock, INVALID leftover rebuilt). */
export async function ensurePostBootIndex(connectionString: string, index: PostBootIndex): Promise<SearchIndexOutcome> {
  // Its own single connection: no statement timeout (the pool's 120s would kill the build on the
  // largest table), and never a connection the request or sweep pools are counting on.
  const conn = postgres(connectionString, {
    prepare: false,
    max: 1,
    idle_timeout: 5,
    connection: { statement_timeout: 0 },
    onnotice: () => undefined,
  });
  try {
    const [lock] = await conn<Array<{ ok: boolean }>>`
      SELECT pg_try_advisory_lock(${index.lockKey}::bigint) AS ok
    `;
    if (!lock.ok) return "busy";
    try {
      const [existing] = await conn<Array<{ valid: boolean }>>`
        SELECT i.indisvalid AS valid
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = ${index.name}
      `;
      if (existing?.valid) return "present";
      if (existing) {
        // Left INVALID by a build that died (we hold the build lock, so nobody is still building it).
        await conn.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
      }
      const startedAt = Date.now();
      await conn.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ${index.name} ${index.on}`);
      console.log(
        `${index.log} ${index.name} ${existing ? "rebuilt" : "built"} ` +
          `in ${Date.now() - startedAt}ms`,
      );
      return existing ? "rebuilt" : "built";
    } finally {
      await conn`SELECT pg_advisory_unlock(${index.lockKey}::bigint)`;
    }
  } finally {
    await conn.end({ timeout: 5 });
  }
}
