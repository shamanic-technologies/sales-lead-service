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
import leadsRoutes from "./routes/leads.js";
import statsRoutes from "./routes/stats.js";
import transferBrandRoutes from "./routes/transfer-brand.js";
import featureMembershipsRoutes from "./routes/feature-memberships.js";
import { registerProviders } from "./lib/register-providers.js";

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
app.use(bufferRoutes);
app.use(leadsRoutes);
app.use(statsRoutes);
app.use(transferBrandRoutes);
app.use(featureMembershipsRoutes);

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

Sentry.setupExpressErrorHandler(app);

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

if (process.env.NODE_ENV !== "test") {
  migrate(db, { migrationsFolder: "./drizzle" })
    .then(async () => {
      console.log("Migrations complete");
      await registerProviders();
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
    })
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });

  process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
    Sentry.captureException(err);
  });
}

export default app;
