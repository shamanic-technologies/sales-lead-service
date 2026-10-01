/**
 * Every REPLY a person sent us, each with the verdict instantly-service currently holds for it —
 * `POST /orgs/reply-verdicts/query`, a contract instantly-service owns and locks.
 *
 * The reply's MEANING for a lead (where they stand) is decided here (reply-outcome.ts); what each
 * reply IS (its kind, its coarse classification, who judged it) is instantly-service's and is read
 * verbatim. Nothing here judges a reply.
 *
 * FAIL LOUD. instantly-service answers 500 rather than an empty list on a read failure, because an
 * empty list would claim these people never replied — the one wrong answer that looks exactly like a
 * correct one. This client keeps that promise: unreachable, a non-2xx, or a body that is not the
 * contract is `ReplyVerdictsUnavailableError`, never `[]`.
 */
import { INSTANTLY_SERVICE_URL, INSTANTLY_SERVICE_API_KEY } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

export class ReplyVerdictsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyVerdictsUnavailableError";
  }
}

/** The verdict instantly-service currently holds for ONE reply. */
export interface ReplyVerdict {
  kind: string;
  classification: "positive" | "negative" | "neutral" | null;
  producerType: string;
  producer: string;
  attribution: string;
  confidence: number | null;
  decidedAt: string | null;
  /** A machine answered (out-of-office, autoresponder): no person engaged. instantly-service's. */
  automatedAnswer: boolean;
  /** They asked us to stop writing to them. instantly-service's. */
  stopRequested: boolean;
  /** Not who we sell to (wrong contact, left the role); a plain "not interested" is NOT this. */
  notOurTarget: boolean;
  /** The reply hands the lead to a person (a referral, an off-topic reply); a plain neutral is NOT. */
  handedToPerson: boolean;
}

/** One real inbound reply, as instantly-service serves it. */
export interface ReplyVerdictView {
  replyId: string;
  leadEmail: string;
  instantlyCampaignId: string;
  /** lead-service's campaign id (campaign-service's), or null when the thread names none. */
  campaignId: string | null;
  brandIds: string[];
  transport: string;
  fromEmail: string | null;
  subject: string | null;
  receivedAt: string;
  /** null = received, not judged yet. */
  verdict: ReplyVerdict | null;
  verdictCount: number;
}

/** The contract's own bound on one request. */
export const REPLY_VERDICTS_MAX_EMAILS = 1_000;
const TIMEOUT_MS = 30_000;

const CLASSIFICATIONS = new Set(["positive", "negative", "neutral"]);

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function parseVerdict(raw: unknown): ReplyVerdict | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") throw new Error("verdict is neither an object nor null");
  const v = raw as Record<string, unknown>;
  if (!isString(v.kind) || v.kind.length === 0) throw new Error("verdict.kind is not a string");
  const classification = v.classification ?? null;
  if (classification !== null && !(isString(classification) && CLASSIFICATIONS.has(classification))) {
    throw new Error(`verdict.classification '${String(classification)}' is not positive|negative|neutral|null`);
  }
  for (const flag of ["automatedAnswer", "stopRequested", "notOurTarget", "handedToPerson"] as const) {
    if (typeof v[flag] !== "boolean") throw new Error(`verdict.${flag} is not a boolean`);
  }
  return {
    automatedAnswer: v.automatedAnswer as boolean,
    stopRequested: v.stopRequested as boolean,
    notOurTarget: v.notOurTarget as boolean,
    handedToPerson: v.handedToPerson as boolean,
    kind: v.kind,
    classification: classification as ReplyVerdict["classification"],
    producerType: isString(v.producerType) ? v.producerType : "",
    producer: isString(v.producer) ? v.producer : "",
    attribution: isString(v.attribution) ? v.attribution : "",
    confidence: typeof v.confidence === "number" ? v.confidence : null,
    decidedAt: isString(v.decidedAt) ? v.decidedAt : null,
  };
}

/** Parse the contract's body. Anything that is not it throws: a half-read list is a wrong list. */
export function parseReplyVerdictsBody(body: unknown): ReplyVerdictView[] {
  if (!body || typeof body !== "object" || !Array.isArray((body as { replies?: unknown }).replies)) {
    throw new Error("body carries no replies array");
  }
  return ((body as { replies: unknown[] }).replies).map((raw, i) => {
    if (!raw || typeof raw !== "object") throw new Error(`replies[${i}] is not an object`);
    const r = raw as Record<string, unknown>;
    if (!isString(r.replyId) || !isString(r.leadEmail) || !isString(r.receivedAt)) {
      throw new Error(`replies[${i}] lacks replyId / leadEmail / receivedAt`);
    }
    if (Number.isNaN(Date.parse(r.receivedAt))) {
      throw new Error(`replies[${i}].receivedAt '${r.receivedAt}' is not a timestamp`);
    }
    return {
      replyId: r.replyId,
      leadEmail: r.leadEmail,
      instantlyCampaignId: isString(r.instantlyCampaignId) ? r.instantlyCampaignId : "",
      campaignId: isString(r.campaignId) ? r.campaignId : null,
      brandIds: Array.isArray(r.brandIds) ? r.brandIds.filter(isString) : [],
      transport: isString(r.transport) ? r.transport : "",
      fromEmail: isString(r.fromEmail) ? r.fromEmail : null,
      subject: isString(r.subject) ? r.subject : null,
      receivedAt: r.receivedAt,
      verdict: parseVerdict(r.verdict ?? null),
      verdictCount: typeof r.verdictCount === "number" ? r.verdictCount : 0,
    };
  });
}

export interface ReplyVerdictsContext {
  orgId: string;
  userId?: string | null;
  runId?: string | null;
}

async function queryOnce(
  emails: string[],
  ctx: ReplyVerdictsContext,
): Promise<ReplyVerdictView[]> {
  const headers: Record<string, string> = {
    "X-API-Key": INSTANTLY_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
    "Content-Type": "application/json",
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.runId) headers["x-run-id"] = ctx.runId;

  let response: Response;
  try {
    response = await fetchWithRetry(`${INSTANTLY_SERVICE_URL}/orgs/reply-verdicts/query`, {
      method: "POST",
      headers,
      body: JSON.stringify({ emails }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new ReplyVerdictsUnavailableError(
      `[reply-verdicts-client] instantly-service unreachable for org ${ctx.orgId}: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ReplyVerdictsUnavailableError(
      `[reply-verdicts-client] instantly-service /orgs/reply-verdicts/query answered ${response.status}` +
        (body ? `: ${body.slice(0, 300)}` : ""),
    );
  }
  try {
    return parseReplyVerdictsBody(await response.json());
  } catch (error) {
    throw new ReplyVerdictsUnavailableError(
      `[reply-verdicts-client] instantly-service reply-verdicts payload unreadable: ${(error as Error).message}`,
    );
  }
}

/**
 * The replies of these people across the whole org, oldest first per person. Bounded requests
 * (the contract takes at most 1,000 addresses), run in series: a list chunk is at most that anyway.
 */
export async function fetchReplyVerdicts(
  emails: readonly string[],
  ctx: ReplyVerdictsContext,
): Promise<ReplyVerdictView[]> {
  const unique = Array.from(
    new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0)),
  );
  const out: ReplyVerdictView[] = [];
  for (let i = 0; i < unique.length; i += REPLY_VERDICTS_MAX_EMAILS) {
    out.push(...(await queryOnce(unique.slice(i, i + REPLY_VERDICTS_MAX_EMAILS), ctx)));
  }
  return out;
}
