/**
 * "Are these two records the same human?" — asked of the fleet's TYPED-JUDGMENT vendor, through
 * chat-service, which owns the model resolution, the credential and the cost declaration.
 *
 * This service never calls a model vendor directly and never declares an LLM cost: it calls
 * chat-service `POST /orgs/judgments` with the caller's own identity, and the spend is metered
 * against that org there.
 *
 * Why a JUDGMENT rather than a completion: the answer that matters here is not prose, it is HOW
 * SURE the model is. A pairing is frozen at write time, so the certainty is what decides whether
 * to freeze at all — `/complete` would hand back a sentence with the confidence silently gone.
 * The vendor answers a `noul` (a yes/no question) with the probability itself, and that number
 * is the whole answer.
 *
 * FAIL SOFT, LOUDLY, IN ONE DIRECTION ONLY. Every failure here — unreachable, refused, unreadable
 * — resolves to a typed reason the caller carries onto the wire, and the pairing stays exactly
 * where the deterministic signal left it. A judgment we could not get NEVER merges two records and
 * NEVER rejects a pairing.
 */
import { CHAT_SERVICE_API_KEY, CHAT_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";
import type { CrmJudgmentUnavailableReason } from "./crm-pairing.js";

const REQUEST_TIMEOUT_MS = 30_000;

/** The caller's key for the one question asked. Comes back under the same name. */
const QUESTION_KEY = "samePerson";

export class JudgmentUnavailableError extends Error {
  readonly reason: CrmJudgmentUnavailableReason;
  constructor(reason: CrmJudgmentUnavailableReason, message: string) {
    super(message);
    this.name = "JudgmentUnavailableError";
    this.reason = reason;
  }
}

export interface JudgmentIdentityContext {
  orgId: string;
  userId: string | null;
  /**
   * chat-service requires a real run id (it becomes the parent of its own run). Absent means we
   * cannot ask at all — reported as `no_run_id`, never worked around with a fabricated uuid,
   * which runs-service rejects as a non-existent parent.
   */
  runId: string | null;
  brandId?: string | null;
}

/** The two sides, as plain facts. Whatever is null is simply absent — nothing is invented. */
export interface SamePersonSides {
  crmContact: {
    fullName: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    company: string | null;
  };
  ourLead: {
    fullName: string | null;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    jobTitle: string | null;
    company: string | null;
    companyDomain: string | null;
    location: string | null;
  };
}

export interface SamePersonJudgment {
  /** 0..1. Near 1 a strong yes, near 0 a strong no, near 0.5 genuinely uncertain. */
  probability: number;
  /** The model RELEASE the vendor reported serving. Frozen with the answer. */
  model: string;
}

const INSTRUCTIONS =
  "The two records below describe a person. One comes from a customer's own CRM, the other from " +
  "our outreach database. Are they the same human being?";

const TRUE_CRITERIA =
  "The same human. Corroborating facts line up — the same employer, the same email local part, a " +
  "nickname or a maiden name of the same person, a matching job title in the same industry.";

const FALSE_CRITERIA =
  "Two different humans who happen to share a name. Nothing beyond the name lines up, or a " +
  "corroborating fact actively conflicts (different employers, different industries, different " +
  "countries). A common surname on its own is not evidence.";

/**
 * Ask whether the two records are the same person.
 *
 * Throws `JudgmentUnavailableError` for every failure so the caller can carry the reason; never
 * returns a default, and never lets an unreadable answer look like a confident one.
 */
export async function judgeSamePerson(
  sides: SamePersonSides,
  ctx: JudgmentIdentityContext,
): Promise<SamePersonJudgment> {
  if (!ctx.runId) {
    throw new JudgmentUnavailableError(
      "no_run_id",
      "no run id on the request, so chat-service has no parent run to hang the judgment on",
    );
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-API-Key": CHAT_SERVICE_API_KEY,
    "x-org-id": ctx.orgId,
    "x-run-id": ctx.runId,
  };
  if (ctx.userId) headers["x-user-id"] = ctx.userId;
  if (ctx.brandId) headers["x-brand-id"] = ctx.brandId;

  return await askJudgment(`${CHAT_SERVICE_URL}/orgs/judgments`, headers, sides);
}

/**
 * The same question, asked with NO org request behind it — the evidence sync's in-process worker,
 * which judges every candidate so none stays undecided because nobody opened a page.
 *
 * It has no user and no run to hang an org-billed judgment on, so it goes through chat-service's
 * platform twin, which declares the spend on a platform run (chat-service owns that declaration,
 * exactly as it owns the org-billed one). Same question, same parse, same typed failures.
 */
export async function judgeSamePersonAsPlatform(sides: SamePersonSides): Promise<SamePersonJudgment> {
  return await askJudgment(
    `${CHAT_SERVICE_URL}/internal/platform-judgments`,
    { "Content-Type": "application/json", "X-API-Key": CHAT_SERVICE_API_KEY },
    sides,
  );
}

async function askJudgment(
  url: string,
  headers: Record<string, string>,
  sides: SamePersonSides,
): Promise<SamePersonJudgment> {
  const body = JSON.stringify({
    state: sides,
    questions: {
      [QUESTION_KEY]: {
        type: "noul",
        instructions: INSTRUCTIONS,
        criteria: { true: TRUE_CRITERIA, false: FALSE_CRITERIA },
      },
    },
  });

  let response: Response;
  try {
    response = await fetchWithRetry(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new JudgmentUnavailableError(
      "judgment_service_unavailable",
      `chat-service unreachable: ${(error as Error).message}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    // A 400 is the vendor refusing the SHAPE of what we sent — the identical request will be
    // refused forever, so it is a different fact from "the service is down".
    const reason: CrmJudgmentUnavailableReason =
      response.status === 400 ? "judgment_refused_request" : "judgment_service_unavailable";
    throw new JudgmentUnavailableError(
      reason,
      `chat-service ${response.status}: ${text.slice(0, 300)}`,
    );
  }

  let parsed: { model?: unknown; answers?: Record<string, unknown> };
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch (error) {
    throw new JudgmentUnavailableError(
      "judgment_answer_unreadable",
      `chat-service answer was not readable JSON: ${(error as Error).message}`,
    );
  }

  const answer = parsed.answers?.[QUESTION_KEY] as { type?: unknown; noul?: unknown } | undefined;
  const probability = answer?.noul;
  if (answer?.type !== "noul" || typeof probability !== "number" || !Number.isFinite(probability)) {
    throw new JudgmentUnavailableError(
      "judgment_answer_unreadable",
      `chat-service answered without a readable "${QUESTION_KEY}" probability`,
    );
  }

  const model = typeof parsed.model === "string" && parsed.model.length > 0 ? parsed.model : null;
  if (!model) {
    // The release is what makes a frozen judgment auditable later. An answer we cannot attribute
    // to a release is not one we are willing to freeze.
    throw new JudgmentUnavailableError(
      "judgment_answer_unreadable",
      "chat-service answered without naming the model release that served the judgment",
    );
  }

  return { probability, model };
}
