import { Router } from "express";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { leadsCampaigns, idempotencyCache } from "../db/schema.js";
import { apiKeyAuth } from "../middleware/auth.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

const TransferBrandBodySchema = z.object({
  sourceBrandId: z.string().uuid(),
  sourceOrgId: z.string().uuid(),
  targetOrgId: z.string().uuid(),
  targetBrandId: z.string().uuid().optional(),
});

router.post("/internal/transfer-brand", apiKeyAuth, async (req, res) => {
  const parsed = TransferBrandBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const runId = req.headers["x-run-id"] as string | undefined;
  if (!runId) {
    res.status(400).json({ error: "x-run-id header required" });
    return;
  }

  const { sourceBrandId, sourceOrgId, targetOrgId, targetBrandId } = parsed.data;

  // Idempotency on x-run-id: replay the cached response if this run already completed.
  const cached = await db.query.idempotencyCache.findFirst({
    where: eq(idempotencyCache.idempotencyKey, runId),
  });
  if (cached) {
    console.log(`[lead-service] transfer-brand idempotency hit for runId=${runId}`);
    res.json(cached.response);
    return;
  }

  traceEvent(
    runId,
    {
      service: "lead-service",
      event: "transfer-brand-start",
      detail: `sourceBrandId=${sourceBrandId}, sourceOrgId=${sourceOrgId}, targetOrgId=${targetOrgId}`,
    },
    req.headers,
  ).catch(() => {});

  console.log(
    `[lead-service] Transfer brand ${sourceBrandId} from org ${sourceOrgId} to org ${targetOrgId}` +
      (targetBrandId ? ` (rewrite to ${targetBrandId})` : ""),
  );

  // Solo-brand condition: brand_ids array length = 1 and the single element matches sourceBrandId.
  const soloBrandCondition = sql`array_length(${leadsCampaigns.brandIds}, 1) = 1 AND ${leadsCampaigns.brandIds}[1] = ${sourceBrandId}`;

  // Step 1: move org for solo-brand rows belonging to the source org.
  const moved = await db
    .update(leadsCampaigns)
    .set({ orgId: targetOrgId, updatedAt: new Date() })
    .where(and(eq(leadsCampaigns.orgId, sourceOrgId), soloBrandCondition))
    .returning({ id: leadsCampaigns.id });

  // Step 2 (optional): rewrite brand id for ALL solo-brand rows for this brand.
  if (targetBrandId) {
    await db
      .update(leadsCampaigns)
      .set({ brandIds: sql`ARRAY[${targetBrandId}]::text[]`, updatedAt: new Date() })
      .where(soloBrandCondition);
  }

  const updatedTables = [{ tableName: "leads_campaigns", count: moved.length }];
  const response = { updatedTables };

  console.log(`[lead-service] Transfer complete: ${JSON.stringify(updatedTables)}`);

  await db.insert(idempotencyCache).values({
    idempotencyKey: runId,
    orgId: targetOrgId,
    response,
  });

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

  res.json(response);
});

export default router;
