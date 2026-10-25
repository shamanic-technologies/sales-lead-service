/**
 * ONBOARDING-EVENTS-TO-LEADS-1025: the named events a brand's product fires for a person (crm-service `product_event`,
 * any client's PostHog custom events) reach Jev's thread as THEIR acts, dated, in crm-service's own words; a product
 * firing one per page never floods the thread (newest ones read, older ones counted).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: { execute: vi.fn() } }));

const { threadLinesOf, PRODUCT_EVENT_LINES } = await import("../../src/lib/relationship-subjects.js");
const { CRM_NOT_THEIR_ACT } = await import("../../src/lib/lead-followup-date.js");

const event = (minute: number, name: string, text: string) => ({
  type: "product_event",
  source: "posthog",
  occurred_at: `2026-10-24T09:${String(minute).padStart(2, "0")}:05.793Z`,
  payload: { event: name, text, properties: {}, sessionId: "s", path: "/get-started", url: "https://distribute.you/get-started" },
});

describe("what Jev reads of a person's walk in the brand's product", () => {
  it("each event is a dated line in crm's words, beside the visit of the same walk", () => {
    const lines = threadLinesOf(
      [
        { type: "website_visit", source: "posthog", occurred_at: "2026-10-24T09:28:13.195Z", payload: { entryPath: "/blog/x", pageviews: 6 } },
        event(29, "get_started_website_submitted", "Get started website submitted · website: www.inogates.com"),
        event(30, "get_started_preview_ready", "Get started preview ready"),
      ],
      [],
    );
    expect(lines.filter((l) => l.kind === "did in the brand's product")).toEqual([
      { at: "2026-10-24T09:29:05.793Z", source: "posthog", kind: "did in the brand's product", direction: null, text: "Get started website submitted · website: www.inogates.com", detail: null },
      { at: "2026-10-24T09:30:05.793Z", source: "posthog", kind: "did in the brand's product", direction: null, text: "Get started preview ready", detail: null },
    ]);
    // Few events: no count line.
    expect(lines.some((l) => l.kind.startsWith("fired "))).toBe(false);
  });

  it("only the newest events are read one by one; older ones are counted", () => {
    const facts = Array.from({ length: PRODUCT_EVENT_LINES + 4 }, (_, i) => event(i, "landing_variant_viewed", "Landing variant viewed"));
    const lines = threadLinesOf(facts, []);
    const dated = lines.filter((l) => l.kind === "did in the brand's product");
    expect(dated).toHaveLength(PRODUCT_EVENT_LINES);
    expect(dated[0].at).toBe("2026-10-24T09:04:05.793Z");
    expect(lines.at(-1)!.kind).toBe(`fired ${PRODUCT_EVENT_LINES + 4} event(s) in the brand's product since 2026-10-24`);
  });

  it("an event crm states with no words reads as its name", () => {
    const lines = threadLinesOf([{ ...event(1, "signup_completed", ""), payload: { event: "signup_completed" } }], []);
    expect(lines[0].text).toBe("signup_completed");
  });

  it("a product event is their act (it moves when they last acted)", () => {
    expect(CRM_NOT_THEIR_ACT as readonly string[]).not.toContain("product_event");
  });
});
