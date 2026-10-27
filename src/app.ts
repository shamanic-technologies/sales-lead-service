/**
 * The Express app every route of this service lives in. Built here, served by the HTTP threads
 * (src/http-worker.ts) behind the request router in src/index.ts.
 */
import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import healthRoutes from "./routes/health.js";
import bufferRoutes from "./routes/buffer.js";
import prospectFollowupRoutes from "./routes/prospect-followup.js";
import leadFollowupDateRoutes from "./routes/lead-followup-date.js";
import crmPairingsRoutes from "./routes/crm-pairings.js";
import leadsRoutes from "./routes/leads.js";
import awaitingReplyRoutes from "./routes/awaiting-reply.js";
import uniboxRoutes from "./routes/unibox.js";
import disqualificationRoutes from "./routes/disqualifications.js";
import notAPersonRoutes from "./routes/not-a-person.js";
import qualificationRoutes from "./routes/qualification.js";
import wonLeadsRoutes from "./routes/won-leads.js";
import neverColdContactRoutes from "./routes/never-cold-contact.js";
import statsRoutes from "./routes/stats.js";
import transferBrandRoutes from "./routes/transfer-brand.js";
import featureMembershipsRoutes from "./routes/feature-memberships.js";
import conversionsRoutes from "./routes/conversions.js";
import stepStatementsRoutes from "./routes/step-statements.js";
import followupsRoutes from "./routes/followups.js";
import existingCustomersRoutes from "./routes/existing-customers.js";
import namedPeopleRoutes from "./routes/named-people.js";
import channelRefusalRoutes from "./routes/channel-refusals.js";
import leadHistoryRoutes from "./routes/lead-history.js";
import crmEvidenceRoutes from "./routes/crm-evidence.js";
import serveRecordsRoutes from "./routes/serve-records.js";
import brandJourneysRoutes from "./routes/brand-journeys.js";
import sentMessagesRoutes from "./routes/sent-messages.js";
import leadProvenanceRoutes from "./routes/lead-provenance.js";
import stepReachedRoutes from "./routes/step-reached.js";
import sourcePeopleRoutes from "./routes/source-people.js";
import sourceLeadsFoundRoutes from "./routes/source-leads-found.js";
import candidateScreeningsRoutes from "./routes/candidate-screenings.js";
import leadIdResolveRoutes from "./routes/lead-id-resolve.js";
import leadStatesRoutes from "./routes/lead-states.js";
import clientSentimentRoutes from "./routes/client-sentiment.js";
import runOutcomeBackfillRoutes from "./routes/run-outcome-backfill.js";
import leadSubjectEquivalencesRoutes from "./routes/lead-subject-equivalences.js";
import outcomeTriggerReResolveRoutes from "./routes/outcome-trigger-reresolve.js";
import meetingAttributionRoutes from "./routes/meeting-attribution.js";
import replyLatencyRoutes from "./routes/reply-latency.js";
import { bodyParserErrorHandler, mountJsonParsers } from "./lib/body-limits.js";
import sourceStockRoutes from "./routes/source-stock.js";
import socialEngagementsRoutes from "./routes/social-engagements.js";
import leadIdentityRoutes from "./routes/lead-identity.js";
import relationshipsRoutes from "./routes/relationships.js";
import { requireBootReady } from "./middleware/readiness.js";
import { withRequestContext } from "./lib/request-context.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

const app = express();

app.use(cors());
// Route-scoped JSON limits first, then the global 100kb default (src/lib/body-limits.ts).
mountJsonParsers(app);
// A body-parser refusal (too large, bad JSON) is a named 4xx, before anything else can read it as a 500.
app.use(bodyParserErrorHandler);
app.use(withRequestContext);

app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res.status(404).json({ error: "OpenAPI spec not generated. Run: npm run generate:openapi" });
  }
});

app.use(healthRoutes);

// Everything below this line is unreachable until migrations have been applied.
// The port opens first (see the boot block in src/index.ts) so a cold database
// cannot eat the deploy's healthcheck window; this gate is what keeps that safe.
app.use(requireBootReady);

app.use(bufferRoutes);
// Registered BEFORE the leads router: its literal `/orgs/leads/crm-pairing*` paths must win
// over `/orgs/leads/:id`, which matches any single segment.
app.use(crmPairingsRoutes);
// Literal `/orgs/leads/crm-evidence/*` paths — registered before `/orgs/leads/:id`.
app.use(crmEvidenceRoutes);
app.use(qualificationRoutes);
// Before leadsRoutes: `/orgs/leads/awaiting-reply` must not be read as a lead id.
app.use(awaitingReplyRoutes);
// Before the leads router too: `/orgs/leads/disqualifications` must not be read as a lead id.
app.use(disqualificationRoutes);
// Before the leads router: /orgs/leads/not-a-person is not a lead id (FAKE-OUTCOMES-1022).
app.use(notAPersonRoutes);
// Before the leads router: /orgs/leads/unibox and /unibox-lead are not lead ids (UNIBOX-SIX-TAGS-1017).
app.use(uniboxRoutes);
app.use(leadsRoutes);
app.use(wonLeadsRoutes);
app.use(neverColdContactRoutes);
app.use(statsRoutes);
app.use(transferBrandRoutes);
app.use(featureMembershipsRoutes);
app.use(conversionsRoutes);
app.use(stepStatementsRoutes);
app.use(followupsRoutes);
app.use(existingCustomersRoutes);
app.use(namedPeopleRoutes);
app.use(channelRefusalRoutes);
app.use(leadHistoryRoutes);
app.use(serveRecordsRoutes);
app.use(brandJourneysRoutes);
app.use(sentMessagesRoutes);
app.use(leadProvenanceRoutes);
app.use(stepReachedRoutes);
app.use(sourcePeopleRoutes);
app.use(sourceLeadsFoundRoutes);
app.use(candidateScreeningsRoutes);
app.use(leadIdResolveRoutes);
app.use(leadStatesRoutes);
// CLIENT-SENTIMENT-1027: every client message of a brand and its Client Sentiment verdict.
app.use(clientSentimentRoutes);
app.use(runOutcomeBackfillRoutes);
app.use(leadSubjectEquivalencesRoutes);
app.use(outcomeTriggerReResolveRoutes);
app.use(meetingAttributionRoutes);
app.use(replyLatencyRoutes);
app.use(sourceStockRoutes);
app.use(socialEngagementsRoutes);
app.use(leadIdentityRoutes);
app.use(relationshipsRoutes);
app.use(prospectFollowupRoutes);
app.use(leadFollowupDateRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

Sentry.setupExpressErrorHandler(app);

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
