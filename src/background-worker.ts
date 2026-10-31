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
import { startClientDateWakeWorker } from "./lib/client-date-wake.js";
import { enableCrossThreadLocks } from "./lib/scope-lock.js";
import { startCrmEvidenceWorker, syncBrandOnce } from "./lib/crm-evidence-worker.js";
import { startBrandSignupsWorker } from "./lib/brand-signups.js";
import { startCrmFactFeedWorker } from "./lib/crm-fact-feed.js";
import { startReadModelWorker } from "./lib/lead-read-model-worker.js";
import { startChangeFeedWorker } from "./lib/lead-change-feed.js";
import { startOutcomeCauseWorker } from "./lib/outcome-cause.js";
import { startTimelineFactsWorker } from "./lib/timeline-facts.js";
import { startOutreachFactFeedWorker } from "./lib/outreach-fact-feed.js";
import { startSocialEngagementsWorker } from "./lib/social-engagements.js";
import { startTriggerEventOutboxWorker } from "./lib/lead-requested-events.js";
import { startRunOutcomeOutboxWorker } from "./lib/run-outcomes.js";
import { startOutcomeFactDeclarationsWorker } from "./lib/outcome-fact-declarations.js";
import { startPostTouchWorker } from "./lib/post-touch.js";
import { startOutcomeTriggerWorker } from "./lib/outcome-triggers.js";
import { startLeadIdentityWorker } from "./lib/lead-identity-sweep.js";
import { startHumanEventsWorker } from "./lib/human-events.js";
import { startHumanOptOutsWorker } from "./lib/human-opt-outs.js";
import { startLeadTimezoneWorker } from "./lib/lead-timezone.js";
import { startRelationshipSweepWorker } from "./lib/relationship-sweep.js";
import { startUniboxFastLaneWorker } from "./lib/unibox-fast-lane.js";
import { startClientSentimentWorker } from "./lib/client-sentiment.js";
import { startChannelSendReconcileWorker } from "./lib/channel-send-reconcile.js";
import { startBrandJournalistsWorker } from "./lib/brand-journalists.js";
import { startStaffIdentityMarksWorker } from "./lib/not-a-person.js";
import { startLeadFollowupDatesWorker } from "./lib/lead-followup-date.js";
import { startLeadSubjectEquivalencesWorker } from "./lib/lead-subject-equivalences.js";
import { fileUniboxLeads, reconcileUniboxLeads } from "./lib/unibox-leads.js";
import { startServeWalkPruneWorker } from "./lib/serve-walk.js";
import { startMemoryReport } from "./lib/memory-report.js";
import { ensurePostBootIndex, ensureReadModelSearchIndex, LOAD_INDEXES, RELATION_KEY_INDEX } from "./lib/read-model-search-index.js";

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
// The people who engage with our social posts: leads of the post's brand, the fact on their timeline.
startSocialEngagementsWorker();
// Every person a brand's CRM says signed up is a lead of the brand (brand-signups.ts); the brand's CRM
// evidence pass then writes their Signup fact.
startBrandSignupsWorker(({ orgId, brandId }) => syncBrandOnce(orgId, brandId));
// Redelivers every on_demand (was lead_requested) trigger event campaign-service has not recorded yet (lead-requested-events.ts).
startTriggerEventOutboxWorker();
// Redelivers every run outcome declaration runs-service has not taken yet (run-outcomes.ts, COST-ACCOUNTING-1023-P1).
startRunOutcomeOutboxWorker();
// Every meeting booked / attended and sale our outreach caused is declared to runs-service's ledger once
// (outcome-fact-declarations.ts, COST-ACCOUNTING-1023-P1).
startOutcomeFactDeclarationsWorker();
// A visit through one of our posts' links, credited to the post's run (FACTORY-P2-CONTENT-OUTCOMES).
startPostTouchWorker();
// Every outcome a person reaches (CRM fact, outcome ledger, booking call) rings its outcome trigger at campaign-service
// once, and every undelivered ring is retried (outcome-triggers.ts, EVERY-OUTCOME-FIRES-1015).
startOutcomeTriggerWorker();
// A lead is a human (human-service) at a company (brand-service): resolves both for every lead and
// writes every employer's firmographics to brand-service (lead-identity-sweep.ts).
startLeadIdentityWorker();
// Follows human-service's fleet identity events: merges move leads to the canonical human, facts
// (opt-out) are copied for the standing (human-events.ts).
startHumanEventsWorker();
// An opt-out observed here (unsubscribe, stop request) is stated on the human in human-service so it
// follows them to every company (human-opt-outs.ts).
startHumanOptOutsWorker();
// Every lead with no timezone gets one inferred from what we hold (phone, location, company, email
// domain), never over a stated or enriched zone (lead-timezone.ts).
startLeadTimezoneWorker();
// Who each person is to each brand: leads from the CRM feed, Jev's tags on the whole thread, suggested
// merges, unknown companies looked up (relationship-sweep.ts, RELATIONSHIP-TAGS-1014).
startRelationshipSweepWorker();
// The people who just wrote to a brand reach its Unibox within a pass, whatever the round's length (UNIBOX-REPLY-LAG-1031).
startUniboxFastLaneWorker();
// Every message a client of a brand writes it is judged once positive / neutral / negative (client-sentiment.ts, CLIENT-SENTIMENT-1027).
startClientSentimentWorker();
// Every served row of a non-email pipe carries what its sender (crm-service) states it sent, live or stopped
// campaign alike (channel-send-reconcile.ts, WA-SENDS-BATCH-1014).
startChannelSendReconcileWorker();
// Who each brand only ever pitched to the press (or a person / Jev says is a journalist): never a lead, refused by
// every sales pool and claim (brand-journalists.ts, JOURNALISTS-NOT-LEADS-1016).
startBrandJournalistsWorker();
// A lead whose every email is a staff address is not a real person: out of every figure (not-a-person.ts, FAKE-OUTCOMES-1022).
startStaffIdentityMarksWorker();
// FACTORY-RECORD-SERVE-1028: serve walks older than their retention are deleted.
startServeWalkPruneWorker();
// Two lead rows our own identity records say are ONE lead (repaired serve, duplicate of one human at one company,
// folded engager) are stated the same subject at runs-service's ledger (lead-subject-equivalences.ts, LEDGER-RESIDUAL-1025).
startLeadSubjectEquivalencesWorker();
// A client's date stated by a campaign wakes that campaign's row at the date (client-date-wake.ts, CLIENT-DATE-WAKE-1030).
startClientDateWakeWorker();
// Every lead of every brand carries a next follow-up date, moved by every send we observe on any channel; the brand's
// Unibox prospects are filed as its leads first (lead-followup-date.ts, unibox-leads.ts, LEAD-FOLLOWUP-DATE-1016).
let uniboxTicks = 0;
startLeadFollowupDatesWorker(async () => {
  // The intake reads every relationship of every candidate: every 7th tick (~15 min) is plenty.
  if (uniboxTicks++ % 7 !== 0) return;
  const kept = await reconcileUniboxLeads();
  if (kept.filedOut > 0 || kept.filedBack > 0) console.log(`[lead-service] unibox leads: filedOut=${kept.filedOut} filedBack=${kept.filedBack} (LEADS-JUDGE-BRAND-1021)`);
  const r = await fileUniboxLeads();
  if (r.filed > 0 || r.ambiguous > 0 || r.malformed > 0) console.log(`[lead-service] unibox intake: candidates=${r.candidates} filed=${r.filed} notProspect=${r.notProspect} ambiguous=${r.ambiguous} malformed=${r.malformed}`);
});

// The Leads search's trigram index, built CONCURRENTLY after boot and never awaited by anything
// (read-model-search-index.ts, DASH-LATENCY-1014). Until it exists a search is slow, not wrong.
ensureReadModelSearchIndex(connectionString).catch((error: unknown) => {
  console.error("[lead-read-model] could not build the search index; searches stay unindexed:", error);
});
// The relationship sweep's "which relations did crm-service identify?" read (LEDGER-RESIDUAL-1025): slow, not wrong, until built.
ensurePostBootIndex(connectionString, RELATION_KEY_INDEX).catch((error: unknown) => {
  console.error("[lead-service] could not build the crm relation-key index; the sweep's identified read stays unindexed:", error);
});
// The sweeps' and standing reads' load indexes (BOX-OVERLOAD-1026), one at a time: slow, not wrong, until built.
void (async () => {
  for (const index of LOAD_INDEXES) {
    await ensurePostBootIndex(connectionString, index).catch((error: unknown) => {
      console.error(`[lead-service] could not build ${index.name}; its reads stay unindexed:`, error);
    });
  }
})();

startMemoryReport("background");

// The sweeps' intervals are unref'd (they must never hold the request process open), so this one
// keeps the thread alive.
setInterval(() => undefined, 60 * 60_000);

console.log("[lead-service] background thread running: crm-evidence, crm-fact-feed, read-model, change-feed, outcome-cause, outreach-fact-feed, timeline, brand-signups, trigger-event-outbox, outcome-triggers, lead-identity, human-events, human-opt-outs, lead-timezone, relationship-sweep, channel-send-reconcile, brand-journalists");

process.on("unhandledRejection", (err) => {
  console.error("[lead-service] background thread unhandled rejection:", err);
});
