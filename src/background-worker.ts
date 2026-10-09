/**
 * The background thread: every interval sweep this service runs, on its OWN event loop.
 *
 * The sweeps re-derive whole scopes (the read models and change feeds of the largest brands are
 * tens of thousands of people every three minutes) and that is CPU. On the request thread they
 * held the event loop long enough that a one-statement `/health` took up to 450ms and the
 * dashboard's 20-row lead page 3.5s, while the same read on an idle loop took 0.3s (measured in
 * production, 2026-10-08). Here they run beside the request thread instead of in front of it.
 *
 * What crosses the boundary is only the database: this thread has its own connection pool, and
 * per-scope serialization with the request thread goes through Postgres advisory locks
 * (scope-lock.ts). Spawned by `src/index.ts` once migrations are done; if it dies the request
 * thread logs it loudly and starts a new one.
 */
import { enableCrossThreadLocks } from "./lib/scope-lock.js";
import { startCrmEvidenceWorker } from "./lib/crm-evidence-worker.js";
import { startCrmFactFeedWorker } from "./lib/crm-fact-feed.js";
import { startReadModelWorker } from "./lib/lead-read-model-worker.js";
import { startChangeFeedWorker } from "./lib/lead-change-feed.js";
import { startOutcomeCauseWorker } from "./lib/outcome-cause.js";
import { startTimelineFactsWorker } from "./lib/timeline-facts.js";
import { startOutreachFactFeedWorker } from "./lib/outreach-fact-feed.js";
import { startTriggerEventOutboxWorker } from "./lib/lead-requested-events.js";

const connectionString = process.env.LEAD_SERVICE_DATABASE_URL;
if (!connectionString) throw new Error("LEAD_SERVICE_DATABASE_URL is not set");

enableCrossThreadLocks(connectionString, 2);

// What each paired customer's CRM evidences, reflected onto their leads.
startCrmEvidenceWorker();
// Copies crm-service's people fact feed into bronze (crm-fact-feed.ts). Copy only. Its one-at-a-time
// flag is enough: this thread is the only caller, no route starts a pull.
startCrmFactFeedWorker();
// Keeps the Leads page's read models inside their freshness bound (see lead-read-model.ts).
startReadModelWorker();
// Keeps every lead change feed a consumer follows current (see lead-change-feed.ts).
startChangeFeedWorker();
// Answers WHOSE WIN every outcome nobody answered was, by the owner's date rule (see outcome-cause.ts).
startOutcomeCauseWorker();
// Copies instantly-service's outreach fact feed into bronze (outreach-fact-feed.ts). Copy only.
startOutreachFactFeedWorker();
// Keeps every brand's labelled timeline (silver lead_timeline_facts) current (see timeline-facts.ts).
startTimelineFactsWorker();
// Redelivers every lead_requested trigger event campaign-service has not recorded yet (lead-requested-events.ts).
startTriggerEventOutboxWorker();

// The sweeps' intervals are unref'd (they must never hold the request process open), so this one
// keeps the thread alive.
setInterval(() => undefined, 60 * 60_000);

console.log("[lead-service] background thread running: crm-evidence, crm-fact-feed, read-model, change-feed, outcome-cause, outreach-fact-feed, timeline, trigger-event-outbox");

process.on("unhandledRejection", (err) => {
  console.error("[lead-service] background thread unhandled rejection:", err);
});
