import { Router } from "express";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { streamServeRecords } from "../lib/serve-records.js";
import { ResponseWriter } from "../lib/stream-writer.js";
import { watchClient, isClientGone } from "../lib/client-abort.js";

const router = Router();

const CHUNK_SIZE = Math.max(1, Number(process.env.LEADS_STREAM_CHUNK_SIZE) || 500);

/**
 * GET /internal/brands/:brandId/serve-records — every serve of the brand (x-org-id scoped): which
 * serve run handed out which person, with that person's identity. Every campaign, every lifecycle
 * status, no per-person dedup (`src/lib/serve-records.ts`).
 *
 * ONE statement streamed to the caller (`{"serves":[...],"count":N}`): the whole brand in one read,
 * never paged, so nothing is re-scanned per page. `count` closes the body so a consumer can check
 * it read every row. A failure before the first byte is a 500; after it, the socket is destroyed
 * (a truncated body is never a complete one). Runs on the `general` HTTP thread like every
 * `/internal` read.
 */
router.get("/internal/brands/:brandId/serve-records", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  const brandId = req.params.brandId as string;
  const writer = new ResponseWriter(res);
  const client = watchClient(req, res);
  let streamingStarted = false;
  try {
    let count = 0;
    for await (const chunk of streamServeRecords(req.orgId!, brandId, CHUNK_SIZE)) {
      client.stopIfGone(count);
      if (!streamingStarted) {
        res.setHeader("Content-Type", "application/json");
        await writer.write('{"serves":[');
        streamingStarted = true;
      }
      for (const record of chunk) {
        await writer.write((count === 0 ? "" : ",") + JSON.stringify(record));
        count += 1;
      }
    }
    if (!streamingStarted) {
      res.setHeader("Content-Type", "application/json");
      await writer.write('{"serves":[');
      streamingStarted = true;
    }
    await writer.write(`],"count":${count}}`);
    await writer.end();
  } catch (error) {
    if (isClientGone(error)) {
      console.warn(`[lead-service] serve-records read abandoned by the caller: ${error.message}`);
      res.destroy();
    } else {
      console.error(`[lead-service] serve-records error for brand ${brandId}:`, error);
      if (streamingStarted || res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      } else {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  } finally {
    client.dispose();
  }
});

export default router;
