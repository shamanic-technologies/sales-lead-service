import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./db/index.js";
import { PORT, PULL_NEXT_TIMEOUT_MS } from "./config.js";
import healthRoutes from "./routes/health.js";
import bufferRoutes from "./routes/buffer.js";
import crmPairingsRoutes from "./routes/crm-pairings.js";
import leadsRoutes from "./routes/leads.js";
import qualificationRoutes from "./routes/qualification.js";
import wonLeadsRoutes from "./routes/won-leads.js";
import statsRoutes from "./routes/stats.js";
import transferBrandRoutes from "./routes/transfer-brand.js";
import featureMembershipsRoutes from "./routes/feature-memberships.js";
import conversionsRoutes from "./routes/conversions.js";
import stepStatementsRoutes from "./routes/step-statements.js";
import followupsRoutes from "./routes/followups.js";
import existingCustomersRoutes from "./routes/existing-customers.js";
import leadHistoryRoutes from "./routes/lead-history.js";
import { registerProviders } from "./lib/register-providers.js";
import { Worker } from "node:worker_threads";
import { extname } from "path";
import { enableCrossThreadLocks } from "./lib/scope-lock.js";
import crmEvidenceRoutes from "./routes/crm-evidence.js";
import { markBootFailed, markBootReady } from "./lib/boot-state.js";
import { withConnectRetry } from "./lib/db-retry.js";
import { requireBootReady } from "./middleware/readiness.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

const app = express();

app.use(cors());
app.use(express.json());

app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res.status(404).json({ error: "OpenAPI spec not generated. Run: npm run generate:openapi" });
  }
});

app.use(healthRoutes);

// Everything below this line is unreachable until migrations have been applied.
// The port opens first (see the boot block at the bottom) so a cold Neon compute
// cannot eat Railway's healthcheck window; this gate is what keeps that safe.
app.use(requireBootReady);

app.use(bufferRoutes);
// Registered BEFORE the leads router: its literal `/orgs/leads/crm-pairing*` paths must win
// over `/orgs/leads/:id`, which matches any single segment.
app.use(crmPairingsRoutes);
// Literal `/orgs/leads/crm-evidence/*` paths — registered before `/orgs/leads/:id`.
app.use(crmEvidenceRoutes);
app.use(qualificationRoutes);
app.use(leadsRoutes);
app.use(wonLeadsRoutes);
app.use(statsRoutes);
app.use(transferBrandRoutes);
app.use(featureMembershipsRoutes);
app.use(conversionsRoutes);
app.use(stepStatementsRoutes);
app.use(followupsRoutes);
app.use(existingCustomersRoutes);
app.use(leadHistoryRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

Sentry.setupExpressErrorHandler(app);

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

/**
 * Boot, port first.
 *
 * Migrations used to run BEFORE `app.listen()`. Neon computes suspend after
 * inactivity, so a deploy landing on a cold compute spent its whole startup
 * budget on the first connection: the port never opened inside Railway's 30s
 * healthcheck window and the deploy was marked FAILED — or the connection was
 * refused mid-resume and `process.exit(1)` turned it into a restart loop. Either
 * way the failure had nothing to do with the code being deployed, which is what
 * made it expensive to diagnose.
 *
 * So the port opens immediately and migrations run behind it, with a
 * connect-phase retry that absorbs the resume. Until they finish, `/health`
 * answers 200 `starting` (Railway sees a live container) while `requireBootReady`
 * 503s every other route — the service never serves traffic against a schema its
 * code does not expect. If migrations ultimately fail, the state flips to
 * `failed`, `/health` 503s, the release is rejected, and the process stays up so
 * the logs carrying the reason survive.
 */
async function boot(): Promise<void> {
  await withConnectRetry(() => migrate(db, { migrationsFolder: "./drizzle" }), {
    onRetry: (attempt, delayMs, err) => {
      console.warn(
        `[lead-service] DB not reachable yet (attempt ${attempt}), retrying in ${delayMs}ms:`,
        err instanceof Error ? err.message : err,
      );
    },
  });
  console.log("Migrations complete");

  // Provider registration is metadata published to key-service, not schema. It
  // must not gate readiness: a key-service outage would otherwise hold the whole
  // service at 503 over something no request depends on.
  // Per-scope locks must hold across this thread and the background one BEFORE either can take
  // one: requests are still gated here, and the background thread starts below.
  enableCrossThreadLocks(process.env.LEAD_SERVICE_DATABASE_URL!, 4);
  markBootReady();
  console.log("[lead-service] ready — serving traffic");

  // The interval sweeps (CRM evidence, read models, change feeds, outcome causes) run on their own
  // thread, so their CPU never stands between a request and its answer (see background-worker.ts).
  // Armed only once the schema they write is there.
  startBackgroundThread();

  try {
    await registerProviders();
  } catch (err) {
    console.error("[lead-service] provider registration failed (continuing):", err);
    Sentry.captureException(err);
  }
}

/** Background thread pool size: its own connections, beside the request thread's `POOL_MAX`. */
const BACKGROUND_DB_POOL_MAX = process.env.LEAD_BACKGROUND_DB_POOL_MAX ?? "8";
const BACKGROUND_RESTART_DELAY_MS = 10_000;

/**
 * Start the background thread, and start it again if it ever stops. A thread that died is a
 * freshness bound nobody keeps (reads would then rebuild their own models), so its end is logged
 * loudly and reported, never swallowed.
 */
function startBackgroundThread(): void {
  const ext = extname(__filename);
  const worker = new Worker(new URL(`./background-worker${ext}`, import.meta.url), {
    env: { ...process.env, LEAD_DB_POOL_MAX: BACKGROUND_DB_POOL_MAX },
    resourceLimits: { maxOldGenerationSizeMb: 1024 },
    ...(ext === ".ts" ? { execArgv: ["--import", "tsx"] } : {}),
  });
  worker.on("error", (err) => {
    console.error("[lead-service] background thread crashed:", err);
    Sentry.captureException(err);
  });
  worker.on("exit", (code) => {
    console.error(
      `[lead-service] background thread exited with code ${code}; restarting in ${BACKGROUND_RESTART_DELAY_MS}ms`,
    );
    setTimeout(startBackgroundThread, BACKGROUND_RESTART_DELAY_MS).unref();
  });
}

if (process.env.NODE_ENV !== "test") {
  const server = app.listen(Number(PORT), "::", () => {
    console.log(`[lead-service] running on port ${PORT}`);
  });
  // Allow socket to outlive the longest in-flight route + 5s grace.
  // Without this Node defaults to no timeout, so a hung downstream can pile up zombie sockets.
  server.setTimeout(PULL_NEXT_TIMEOUT_MS + 5_000);

  const shutdown = () => {
    console.log("Shutting down gracefully...");
    server.close(() => {
      sql.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  boot().catch((err) => {
    console.error("Migration failed:", err);
    Sentry.captureException(err);
    markBootFailed(err);
  });

  process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
    Sentry.captureException(err);
  });
}

export default app;
