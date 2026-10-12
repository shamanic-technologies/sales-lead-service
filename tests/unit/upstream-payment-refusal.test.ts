import { afterEach, describe, expect, it, vi } from "vitest";
import { complete } from "../../src/lib/chat-complete-client.js";
import { isCreditInsufficientError, paymentRefusal } from "../../src/lib/credit-errors.js";
import { storeImage } from "../../src/lib/image-store-client.js";
import { judgeYesNo } from "../../src/lib/qualification-judge.js";
import { InsufficientCreditError } from "../../src/lib/treg-client.js";

const id = { orgId: "org-1", userId: "u", runId: "r", brandId: null, campaignId: null, workflowSlug: null, featureSlug: null };
const chatRefusal = JSON.stringify({ error: "Insufficient credits", balance_cents: 0, required_cents: 3 });

afterEach(() => vi.unstubAllGlobals());

function answer(status: number, body: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
}

describe("a sibling that owns the spend refuses for lack of money (402)", () => {
  it("chat-service /complete: InsufficientCreditError with its figures", async () => {
    answer(402, chatRefusal);
    const err = await complete({ systemPrompt: "s", message: "m" }, id).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditError);
    expect(err).toMatchObject({ balanceCents: 0, requiredCents: 3 });
    expect(isCreditInsufficientError(err)).toBe(true);
  });

  it("chat-service /orgs/judgments: InsufficientCreditError", async () => {
    answer(402, chatRefusal);
    const err = await judgeYesNo({ a: 1 }, { q: { instructions: "?" } }, id).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditError);
  });

  it("cloudflare-service /upload: InsufficientCreditError, figures null when unstated", async () => {
    answer(402, "Payment Required");
    const err = await storeImage("https://x/y.png", "y.png", id).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditError);
    expect(err).toMatchObject({ balanceCents: null, requiredCents: null });
  });

  it("any other failure keeps its own error, never a payment refusal", async () => {
    answer(500, chatRefusal);
    const err = await complete({ systemPrompt: "s", message: "m" }, id).catch((e) => e);
    expect(err).not.toBeInstanceOf(InsufficientCreditError);
    expect(err.message).toMatch(/500/);
    expect(paymentRefusal(403, chatRefusal)).toBeNull();
  });
});
