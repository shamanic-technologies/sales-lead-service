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
import crmEvidenceRoutes from "./routes/crm-evidence.js";
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

export default app;
