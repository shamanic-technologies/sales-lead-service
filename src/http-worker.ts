/**
 * An HTTP thread: serves the whole Express app (src/app.ts) on a loopback port, behind the request
 * router in src/index.ts. Two of these run — `general` (every route) and `interactive` (the
 * dashboard's paged reads only, see request-routing.ts) — each on its own event loop, so a
 * whole-population walk on one never stands between a dashboard read and its answer on the other.
 *
 * It serves nothing until the main thread says migrations are applied (`requireBootReady` gates
 * every route on this thread's own boot state, set by that message).
 */
import * as Sentry from "@sentry/node";
import { parentPort, workerData } from "node:worker_threads";
import app from "./app.js";
import { PULL_NEXT_TIMEOUT_MS } from "./config.js";
import { markBootFailed, markBootReady } from "./lib/boot-state.js";
import { enableCrossThreadLocks } from "./lib/scope-lock.js";

const { name, port, lockPoolMax } = workerData as { name: string; port: number; lockPoolMax: number };

const connectionString = process.env.LEAD_SERVICE_DATABASE_URL;
if (!connectionString) throw new Error("LEAD_SERVICE_DATABASE_URL is not set");
enableCrossThreadLocks(connectionString, lockPoolMax);

parentPort!.on("message", (message: { type: "boot-ready" } | { type: "boot-failed"; error: string }) => {
  if (message.type === "boot-ready") {
    markBootReady();
    parentPort!.postMessage({ type: "serving" });
  } else {
    markBootFailed(new Error(message.error));
  }
});

const server = app.listen(port, "127.0.0.1", () => {
  console.log(`[lead-service] ${name} HTTP thread listening on 127.0.0.1:${port}`);
  parentPort!.postMessage({ type: "listening" });
});
// Same bound as the public socket: the longest in-flight route + 5s grace.
server.setTimeout(PULL_NEXT_TIMEOUT_MS + 5_000);

process.on("unhandledRejection", (err) => {
  console.error(`[lead-service] ${name} HTTP thread unhandled rejection:`, err);
  Sentry.captureException(err);
});
