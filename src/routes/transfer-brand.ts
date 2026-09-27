import { Router } from "express";
import { z } from "zod";
import { apiKeyAuth } from "../middleware/auth.js";
import { traceEvent } from "../lib/trace-event.js";
import { SharedBrandRowsError, transferBrand } from "../lib/brand-transfer.js";

const router = Router();

const TransferBrandBodySchema = z.object({
  sourceBrandId: z.string().uuid(),
  sourceOrgId: z.string().uuid(),
  targetOrgId: z.string().uuid(),
  targetBrandId: z.string().uuid().optional(),
});

/**
 * The fleet's LOCKED brand-transfer contract (brand-service fans it out). Moves every row this
 * service holds for the brand from `sourceOrgId` to `targetOrgId` — see `src/lib/brand-transfer.ts`.
 * Idempotent by construction: a second call moves nothing and reports zero everywhere. brand-service
 * sends no `x-run-id`, so none is required; when one is present it is only used for tracing.
 */
router.post("/internal/transfer-brand", apiKeyAuth, async (req, res) => {
  const parsed = TransferBrandBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const input = parsed.data;
  if (input.sourceOrgId === input.targetOrgId) {
    res.status(400).json({ error: "sourceOrgId and targetOrgId must differ" });
    return;
  }

  const runId = req.headers["x-run-id"] as string | undefined;
  const detail =
    `sourceBrandId=${input.sourceBrandId}, sourceOrgId=${input.sourceOrgId}, ` +
    `targetOrgId=${input.targetOrgId}, targetBrandId=${input.targetBrandId ?? "-"}`;
  if (runId) {
    traceEvent(runId, { service: "lead-service", event: "transfer-brand-start", detail }, req.headers)
      .catch(() => {});
  }
  console.log(`[lead-service] transfer-brand start: ${detail}`);

  try {
    const updatedTables = await transferBrand(input);
    console.log(`[lead-service] transfer-brand done: ${detail} moved=${JSON.stringify(updatedTables)}`);
    if (runId) {
      traceEvent(
        runId,
        {
          service: "lead-service",
          event: "transfer-brand-done",
          detail: `updated: ${JSON.stringify(updatedTables)}`,
          data: { updatedTables },
        },
        req.headers,
      ).catch(() => {});
    }
    res.json({ updatedTables });
  } catch (err) {
    if (err instanceof SharedBrandRowsError) {
      console.error(`[lead-service] transfer-brand refused: ${detail}: ${err.message}`);
      res.status(409).json({ error: err.message, shared: err.shared });
      return;
    }
    console.error(`[lead-service] transfer-brand failed: ${detail}`, err);
    res.status(500).json({
      error: `transfer-brand failed, nothing was moved: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
});

export default router;
