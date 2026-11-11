/**
 * "Needs your call" (owner 2026-10-11): the people who wrote back and are waiting on US.
 *
 *   GET  /orgs/leads/awaiting-reply?brandId=      every person waiting, oldest wait first, with since
 *                                                 when and what kind of message they sent; `total` is
 *                                                 the length of the same list (count and list are one set).
 *                                                 A person one of our people answered from Gmail (org or
 *                                                 staff mailbox, judged an answer by Jev) leaves it by itself.
 *                                                 Personal channels (WhatsApp...) read the same way: their
 *                                                 message waits on us (judged once by Jev), ours answers.
 *   POST /orgs/leads/:id/answered-outside         "I answered this person outside the platform": a fact
 *                                                 about the PERSON at the brand (who, when); a later new
 *                                                 message from them puts them back.
 *
 * Rule and IO: src/lib/awaiting-reply.ts, awaiting-reply-read.ts. Mounted BEFORE the leads router so
 * `/orgs/leads/awaiting-reply` is not read as a lead id (the gateway reaches it through `/v1/leads/:id`).
 */
import { messageOf } from "../lib/db-error.js";
import { Router, type Response } from "express";
import { sql } from "../db/index.js";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import {
  OutreachCopyNotReadyError,
  readAwaitingReply,
  readAwaitingReplyWithReport,
  recordAnsweredOutside,
} from "../lib/awaiting-reply-read.js";
import { acceptQuery } from "../lib/query-params.js";
import { READ_QUERY_PARAMS } from "../lib/read-query-vocabulary.js";
import { invalidateAndRebuild, invalidateSnapshots, readThroughSnapshot } from "../lib/read-snapshots.js";

const router = Router();

/**
 * "Who is waiting on us" is a brand-wide read (the brand's personal-channel messages + both Gmail mirrors per person
 * waiting: 10-13 s cold on the largest brand): with the request's identity it is served from its stored answer and
 * recomputed in the background, with that identity, once 10 s old: each read still pays the computation it paid before,
 * off its path (read-snapshots.ts, MON-PAGE-SPEED-1111). A new message shows on the read after the one that started its
 * rebuild. The "answered outside" statement invalidates it before answering. A read without identity computes as before (its
 * mirrors cannot be read, so its answer is not the one stored).
 */
const AWAITING_REVALIDATE_AFTER_MS = 10_000;

function awaitingBody(orgId: string, brandId: string, mailboxCheck: { userId: string; runId: string }) {
  return async () => {
    const { people, outsideAnswers, personalMessages } = await readAwaitingReplyWithReport({ orgId, brandId, mailboxCheck });
    return JSON.stringify({ brandId, total: people.length, people, outsideAnswers, personalMessages });
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function respondReadFailure(res: Response, error: unknown, what: string) {
  if (error instanceof OutreachCopyNotReadyError) {
    res.status(503).json({ error: messageOf(error), code: "outreach_copy_not_ready" });
    return;
  }
  console.error(`[lead-service] ${what} failed:`, error);
  res.status(500).json({ error: `${what} failed` });
}

router.get("/orgs/leads/awaiting-reply", apiKeyAuth, requireOrgId, acceptQuery(READ_QUERY_PARAMS["GET /orgs/leads/awaiting-reply"]), async (req: AuthenticatedRequest, res) => {
  try {
    const brandId = typeof req.query.brandId === "string" ? req.query.brandId.trim() : "";
    if (!brandId) {
      res.status(400).json({ error: "brandId is required" });
      return;
    }
    // Every person still waiting has the Gmail mirrors (the org's own, and staff's) read for a later
    // email of ours, judged once by Jev, billed to this request's org (outside-answers.ts).
    if (req.userId && req.runId) {
      const body = await readThroughSnapshot({
        kind: "awaiting_reply",
        orgId: req.orgId!,
        brandId,
        revalidateAfterMs: AWAITING_REVALIDATE_AFTER_MS,
        compute: awaitingBody(req.orgId!, brandId, { userId: req.userId, runId: req.runId }),
      });
      res.type("application/json").send(body);
      return;
    }
    const { people, outsideAnswers, personalMessages } = await readAwaitingReplyWithReport({
      orgId: req.orgId!,
      brandId,
      mailboxCheck: { userId: req.userId ?? null, runId: req.runId ?? null },
    });
    res.json({ brandId, total: people.length, people, outsideAnswers, personalMessages });
  } catch (error) {
    respondReadFailure(res, error, "awaiting-reply read");
  }
});

router.post("/orgs/leads/:id/answered-outside", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  try {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id must be the `id` of a lead row, a uuid" });
      return;
    }
    if (!req.userId) {
      res.status(400).json({ error: "x-user-id is required: the statement records who answered" });
      return;
    }
    const rows = (await sql`
      SELECT id::text AS id, lead_id::text AS lead_id, brand_ids
      FROM leads_campaigns WHERE id = ${id} AND org_id = ${req.orgId!} LIMIT 1
    `) as unknown as Array<{ id: string; lead_id: string; brand_ids: string[] }>;
    const row = rows[0];
    // A brand named (query or header) that the row is not part of is indistinguishable from an
    // absent row; with none named, the row's own brand.
    const fromQuery = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
    const requested = fromQuery ? [fromQuery] : (req.brandIds ?? []);
    const brandId = !row
      ? null
      : requested.length > 0
        ? (requested.find((b) => row.brand_ids.includes(b)) ?? null)
        : (row.brand_ids[0] ?? null);
    if (!row || !brandId) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const statement = await recordAnsweredOutside({
      orgId: req.orgId!,
      brandId,
      leadId: row.lead_id,
      leadCampaignId: row.id,
      statedByUserId: req.userId,
    });
    const after = await readAwaitingReply({ orgId: req.orgId!, brandId, leadIds: [row.lead_id] });
    if (req.runId) {
      await invalidateAndRebuild({ kind: "awaiting_reply", orgId: req.orgId!, brandId, compute: awaitingBody(req.orgId!, brandId, { userId: req.userId, runId: req.runId }) });
    } else {
      await invalidateSnapshots("awaiting_reply", req.orgId!, brandId);
    }
    res.status(201).json({
      statement: { id: statement.id, leadId: row.lead_id, brandId, statedByUserId: req.userId, statedAt: statement.statedAt },
      awaitingReply: after.length > 0,
    });
  } catch (error) {
    respondReadFailure(res, error, "answered-outside statement");
  }
});

export default router;
