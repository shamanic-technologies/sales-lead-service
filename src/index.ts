/**
 * The process entry: the public port, boot (migrations), and the threads that do the work.
 *
 * This thread does almost nothing per request, on purpose. It answers `/health` and
 * `/openapi.json` itself and hands every other request, byte for byte, to one of two HTTP threads
 * (src/http-worker.ts) running the same Express app (src/app.ts):
 *
 *   - `interactive`: the reads a person waits on in the dashboard (request-routing.ts);
 *   - `general`: everything else — every write, the serve path, whole-population walks.
 *
 * Why. With every route on one event loop, the machine readers (features-service walking whole
 * brands 5,000 compact rows at a time, change feeds, step-disqualification reads) kept that loop
 * busy, and every `await` of a 20-row dashboard page queued behind them: 1.5-3.5s in production
 * where the same read on an idle loop took 0.3s (2026-10-08). The interval sweeps already run on
 * their own thread (src/background-worker.ts); this gives the dashboard's reads one too.
 */
import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import http from "node:http";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, extname, join } from "path";
import { Worker } from "node:worker_threads";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, sql } from "./db/index.js";
import { PORT, PULL_NEXT_TIMEOUT_MS } from "./config.js";
import healthRoutes from "./routes/health.js";
import { getBootFailure, getBootState, markBootFailed, markBootReady } from "./lib/boot-state.js";
import { withConnectRetry } from "./lib/db-retry.js";
import { registerProviders } from "./lib/register-providers.js";
import { requireBootReady } from "./middleware/readiness.js";
import { isInteractiveRead } from "./request-routing.js";

const __filename = fileURLToPath(import.meta.url);
const EXT = extname(__filename);
const openapiPath = join(dirname(__filename), "..", "openapi.json");

function threadUrl(name: string): URL {
  return new URL(`./${name}${EXT}`, import.meta.url);
}

const threadOptions = (env: Record<string, string>) => ({
  env: { ...process.env, ...env },
  resourceLimits: { maxOldGenerationSizeMb: 1024 },
  ...(EXT === ".ts" ? { execArgv: ["--import", "tsx"] } : {}),
});

const THREAD_RESTART_DELAY_MS = 1_000;
const BACKGROUND_RESTART_DELAY_MS = 10_000;

// ── HTTP threads ─────────────────────────────────────────────────────────────────────────────

interface HttpThread {
  name: "general" | "interactive";
  port: number;
  poolMax: string;
  lockPoolMax: number;
  worker: Worker | null;
  /** Listening and serving (it has applied boot-ready): requests may go to it. */
  up: boolean;
}

const publicPort = Number(PORT);
const httpThreads: Record<HttpThread["name"], HttpThread> = {
  general: {
    name: "general",
    port: publicPort + 1,
    poolMax: process.env.LEAD_DB_POOL_MAX ?? "20",
    lockPoolMax: 4,
    worker: null,
    up: false,
  },
  interactive: {
    name: "interactive",
    port: publicPort + 2,
    poolMax: process.env.LEAD_INTERACTIVE_DB_POOL_MAX ?? "8",
    lockPoolMax: 2,
    worker: null,
    up: false,
  },
};

function tellBootState(thread: HttpThread): void {
  const state = getBootState();
  if (state === "ready") thread.worker?.postMessage({ type: "boot-ready" });
  if (state === "failed") thread.worker?.postMessage({ type: "boot-failed", error: getBootFailure() ?? "unknown" });
}

/**
 * Start an HTTP thread, and start it again if it ever stops — loudly: while it is down its share of
 * the traffic goes to the other thread (interactive) or is refused with a 503 (general).
 */
function startHttpThread(thread: HttpThread): void {
  const worker = new Worker(threadUrl("http-worker"), {
    ...threadOptions({ LEAD_DB_POOL_MAX: thread.poolMax }),
    workerData: { name: thread.name, port: thread.port, lockPoolMax: thread.lockPoolMax },
  });
  thread.worker = worker;
  worker.on("message", (message: { type: string }) => {
    // Listening: tell it the boot state. Serving: it has applied that state, so requests may go.
    if (message.type === "listening") tellBootState(thread);
    if (message.type === "serving") thread.up = true;
  });
  worker.on("error", (err) => {
    console.error(`[lead-service] ${thread.name} HTTP thread crashed:`, err);
    Sentry.captureException(err);
  });
  worker.on("exit", (code) => {
    thread.up = false;
    thread.worker = null;
    console.error(
      `[lead-service] ${thread.name} HTTP thread exited with code ${code}; restarting in ${THREAD_RESTART_DELAY_MS}ms`,
    );
    setTimeout(() => startHttpThread(thread), THREAD_RESTART_DELAY_MS).unref();
  });
}

/** Background thread pool size: its own connections, beside the HTTP threads'. */
const BACKGROUND_DB_POOL_MAX = process.env.LEAD_BACKGROUND_DB_POOL_MAX ?? "8";

/**
 * Start the background thread, and start it again if it ever stops. A thread that died is a
 * freshness bound nobody keeps (reads would then rebuild their own models), so its end is logged
 * loudly and reported, never swallowed.
 */
function startBackgroundThread(): void {
  const worker = new Worker(threadUrl("background-worker"), threadOptions({ LEAD_DB_POOL_MAX: BACKGROUND_DB_POOL_MAX }));
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

// ── the router ───────────────────────────────────────────────────────────────────────────────

/** Connection-scoped headers: each hop sets its own. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

function forwardableRequestHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(key)) out[key] = value;
  }
  return out;
}

function forwardableResponseHeaders(raw: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (!HOP_BY_HOP.has(raw[i].toLowerCase())) out.push(raw[i], raw[i + 1]);
  }
  return out;
}

/** Hand the request to a thread and its answer back, untouched; a caller who leaves cancels it. */
function forward(req: express.Request, res: express.Response, thread: HttpThread): void {
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: thread.port,
      method: req.method,
      path: req.originalUrl,
      headers: forwardableRequestHeaders(req.headers),
      agent: upstreamAgent,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, forwardableResponseHeaders(upstreamRes.rawHeaders));
      upstreamRes.pipe(res);
      upstreamRes.on("error", (err) => res.destroy(err));
    },
  );
  upstream.on("error", (err) => {
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    console.error(`[lead-service] ${thread.name} HTTP thread did not answer ${req.method} ${req.originalUrl}:`, err);
    res.status(502).json({ error: `lead-service ${thread.name} HTTP thread unavailable` });
  });
  // The caller left: stop the work it asked for (the thread's own client-abort checks see it).
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.pipe(upstream);
}

const router = express();
router.disable("x-powered-by");

// Answered here, with the same middleware they always had: liveness must not depend on a thread.
router.get("/openapi.json", cors(), (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res.status(404).json({ error: "OpenAPI spec not generated. Run: npm run generate:openapi" });
  }
});
router.use("/health", cors());
router.use(healthRoutes);

// Nothing is handed to a thread before migrations are applied (see boot below).
router.use(requireBootReady);

router.use((req, res) => {
  const { general, interactive } = httpThreads;
  const target = isInteractiveRead(req.method, req.originalUrl) && interactive.up ? interactive : general;
  if (!target.up) {
    res.status(503).json({ error: "lead-service is restarting its request thread; retry shortly" });
    return;
  }
  forward(req, res, target);
});

// ── boot ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Boot, port first.
 *
 * Migrations used to run BEFORE `app.listen()`. A deploy landing on a database not yet accepting
 * connections spent its whole startup budget on the first connection: the port never opened inside
 * the healthcheck window and the deploy was marked FAILED — or the connection was refused and
 * `process.exit(1)` turned it into a restart loop. Either way the failure had nothing to do with the
 * code being deployed, which is what made it expensive to diagnose.
 *
 * So the port opens immediately and migrations run behind it, with a connect-phase retry. Until
 * they finish, `/health` answers 200 `starting` while `requireBootReady` 503s every other route —
 * the service never serves traffic against a schema its code does not expect. If migrations
 * ultimately fail, the state flips to `failed`, `/health` 503s, the release is rejected, and the
 * process stays up so the logs carrying the reason survive.
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

  markBootReady();
  for (const thread of Object.values(httpThreads)) tellBootState(thread);
  console.log("[lead-service] ready — serving traffic");

  // The interval sweeps (CRM evidence, read models, change feeds, outcome causes) run on their own
  // thread, so their CPU never stands between a request and its answer (see background-worker.ts).
  // Armed only once the schema they write is there.
  startBackgroundThread();

  // Provider registration is metadata published to key-service, not schema. It must not gate
  // readiness: a key-service outage would otherwise hold the whole service at 503 over something no
  // request depends on.
  try {
    await registerProviders();
  } catch (err) {
    console.error("[lead-service] provider registration failed (continuing):", err);
    Sentry.captureException(err);
  }
}

if (process.env.NODE_ENV !== "test") {
  const server = router.listen(publicPort, "::", () => {
    console.log(`[lead-service] running on port ${PORT}`);
  });
  // Allow socket to outlive the longest in-flight route + 5s grace.
  // Without this Node defaults to no timeout, so a hung downstream can pile up zombie sockets.
  server.setTimeout(PULL_NEXT_TIMEOUT_MS + 5_000);

  // The HTTP threads open their loopback ports now and serve once boot says the schema is there.
  for (const thread of Object.values(httpThreads)) startHttpThread(thread);

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
    for (const thread of Object.values(httpThreads)) tellBootState(thread);
  });

  process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
    Sentry.captureException(err);
  });
}

export default router;
