import express, { Router } from "express";
import { z } from "zod";
import { apiKeyAuth } from "../middleware/auth.js";
import { loadReplyLatencyByGroups, REPLY_LATENCY_MAX_GROUPS, REPLY_LATENCY_MAX_IDS_PER_GROUP } from "../lib/reply-latency.js";

const router = Router();

/** Groups of up to 500 campaign ids each outgrow the default 100kb body: app.ts mounts this BEFORE its global parser. */
export const REPLY_LATENCY_PATH = "/internal/reply-latency";
export const replyLatencyBodyParser = express.json({ limit: "4mb" });

const Body = z.object({
  groups: z
    .record(
      z.string().min(1),
      z.object({ campaignIds: z.array(z.string().min(1)).min(1).max(REPLY_LATENCY_MAX_IDS_PER_GROUP) }),
    )
    .refine((g) => Object.keys(g).length >= 1 && Object.keys(g).length <= REPLY_LATENCY_MAX_GROUPS, {
      message: `groups: 1..${REPLY_LATENCY_MAX_GROUPS} groups`,
    }),
});

/**
 * POST /internal/reply-latency/grouped — per group of campaign ids, the time from a person's FIRST message we sent
 * under those campaigns (any channel) to their FIRST POSITIVE reply after it, since inception
 * (REPLY-LATENCY-ALL-CHANNELS-1019, src/lib/reply-latency.ts). Fleet-wide (no org): a group may hold every org's
 * campaigns on one pipe. A failed read is a 500, never zeros.
 */
router.post("/internal/reply-latency/grouped", apiKeyAuth, async (req, res) => {
  const parsed = Body.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", detail: parsed.error.issues });
    return;
  }
  const groups = Object.entries(parsed.data.groups).map(([key, g]) => ({ key, campaignIds: g.campaignIds }));
  try {
    res.json({ basis: "first_message_sent_to_first_positive_reply_since_inception", groups: await loadReplyLatencyByGroups(groups) });
  } catch (err) {
    console.error(`[lead-service] POST reply-latency/grouped failed groups=${groups.map((g) => g.key).join(",")}:`, err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
});

export default router;
