import { afterEach, describe, expect, it, vi } from "vitest";
import { complete } from "../../src/lib/chat-complete-client.js";
import { fundingCapOf, isCreditInsufficientError, paymentRefusal } from "../../src/lib/credit-errors.js";
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

  it("reads cents stated as decimal strings, as chat-service sends them (prod 2026-10-12)", async () => {
    answer(402, JSON.stringify({ error: "Insufficient credits", balance_cents: "-1.2800000000", required_cents: "1.2800000000" }));
    const err = await complete({ systemPrompt: "s", message: "m" }, id).catch((e) => e);
    expect(err).toMatchObject({ balanceCents: -1.28, requiredCents: 1.28 });
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

describe("a sibling relays billing's sales-funnel MAX BUDGET refusal (FUNNEL-CAP-NAMED-402-1016)", () => {
  const cap = { salesFunnelId: "sf-1", salesFunnelCampaignId: "c-1", amountCents: 5000, period: "day", consumedCents: 5000, reservedCents: 0 };
  const capRefusal = JSON.stringify({ error: "Sales funnel max budget reached", reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap, balance_cents: 90000, required_cents: 3 });

  it("chat-service 402 naming the cap: still a stop, and the cause is kept verbatim", async () => {
    answer(402, capRefusal);
    const err = await complete({ systemPrompt: "s", message: "m" }, id).catch((e) => e);
    expect(err).toBeInstanceOf(InsufficientCreditError);
    expect(isCreditInsufficientError(err)).toBe(true);
    expect(err.fundingCap).toEqual({ reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap });
    expect(fundingCapOf(err)).toEqual({ reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap });
  });

  it("a balance 402 (no reason) carries no cap", () => {
    const err = paymentRefusal(402, chatRefusal);
    expect(err?.fundingCap).toBeNull();
    expect(err?.message).toBe("insufficient credit: balance 0c, required 3c");
  });

  it("a structured 402 body with the cap reason but no `type` is still a credit stop", () => {
    const err = { status: 402, body: JSON.parse(capRefusal) };
    expect(isCreditInsufficientError(err)).toBe(true);
    expect(fundingCapOf(err)).toEqual({ reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap });
  });

  it("apollo-service 402 keeping `type: credit_insufficient` + reason: stop, cause kept", () => {
    const body = { type: "credit_insufficient", error: "Sales funnel max budget reached", reason: "sales_funnel_max_budget_unreadable", sales_funnel_cap: cap };
    const err = { status: 402, body };
    expect(isCreditInsufficientError(err)).toBe(true);
    expect(fundingCapOf(err)?.reason).toBe("sales_funnel_max_budget_unreadable");
  });

  it("apollo's cap 402 relayed by human-service as a 502 (body embedded in a string): stop, cause kept", () => {
    const apolloBody = JSON.stringify({ type: "credit_insufficient", error: "Sales funnel max budget reached", reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap });
    const humanBody = JSON.stringify({ error: `Apollo serve failed: 402 - ${apolloBody}`, provider: "apollo", upstreamStatus: 402 });
    const err = Object.assign(new Error(`People gateway call failed: 502 - ${humanBody}`), { status: 502, body: JSON.parse(humanBody), responseText: humanBody });
    expect(isCreditInsufficientError(err)).toBe(true);
    expect(fundingCapOf(err)).toEqual({ reason: "sales_funnel_max_budget_reached", sales_funnel_cap: cap });
  });

  it("an unknown reason is not a funding cap", () => {
    expect(fundingCapOf({ status: 402, body: { error: "x", reason: "something_else" } })).toBeNull();
    expect(isCreditInsufficientError({ status: 402, body: { error: "x", reason: "something_else" } })).toBe(false);
  });
});
