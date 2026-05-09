import { Router } from "express";
import { sql as drizzleSql } from "drizzle-orm";
import { db } from "../db/index.js";

const router = Router();

const DB_PING_TIMEOUT_MS = 2_000;

router.get("/health", async (_req, res) => {
  try {
    await Promise.race([
      db.execute(drizzleSql`SELECT 1`),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db ping timeout")), DB_PING_TIMEOUT_MS),
      ),
    ]);
    res.json({ status: "ok", service: "lead-service" });
  } catch (err) {
    console.error("[lead-service] /health DB ping failed:", err);
    res.status(503).json({ status: "unavailable", service: "lead-service" });
  }
});

export default router;
