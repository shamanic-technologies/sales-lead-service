/**
 * JEV-WEAK-EVIDENCE-1025: a newsletter reader who visited the brand's site was judged "not a lead" (prospect 0.32)
 * because Jev saw ONE undated "visited the website" line, and the prospect question read a thin thread as a no.
 *  - the thread shows each recent visit dated, with what it shows (entry page, first URL and its utm source, pages);
 *  - the brand's own CRM filing (`contactType`, lead source) reaches Jev;
 *  - the prospect question says coming toward the brand IS the prospect signal; only another relationship rules it out.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ db: { execute: vi.fn() } }));

const { threadLinesOf, VISIT_LINES } = await import("../../src/lib/relationship-subjects.js");
const { TAG_QUESTIONS, fitThread } = await import("../../src/lib/relationship-judge.js");

const visit = (day: number) => ({
  type: "website_visit",
  source: "posthog",
  occurred_at: `2026-10-${String(day).padStart(2, "0")}T09:28:13.195Z`,
  payload: {
    sessionId: "s",
    endedAt: "x",
    firstUrl: "https://distribute.you/blog/gtm-ai-llm-judge?utm_source=newsletter&utm_medium=email&utm_campaign=jev-gtm",
    entryPath: "/blog/gtm-ai-llm-judge",
    referrer: "$direct",
    pageviews: 6,
  },
});

describe("what Jev reads about a visitor", () => {
  it("a visit is a dated line with its entry page, first URL (utm) and pages, plus a summary line", () => {
    const lines = threadLinesOf([visit(24)], []);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      at: "2026-10-24T09:28:13.195Z",
      kind: "visited the brand's website",
      detail: { entryPath: "/blog/gtm-ai-llm-judge", pageviews: 6, firstUrl: expect.stringContaining("utm_source=newsletter") },
    });
    // Session plumbing is not evidence.
    expect(lines[0].detail).not.toHaveProperty("sessionId");
    expect(lines[1]).toMatchObject({ at: null, kind: "visited the brand's website 1 time(s) since 2026-10-24" });
  });

  it("only the newest visits are read one by one; older ones are counted", () => {
    const facts = Array.from({ length: VISIT_LINES + 3 }, (_, i) => visit(i + 1));
    const lines = threadLinesOf(facts, []);
    const dated = lines.filter((l) => l.kind === "visited the brand's website");
    expect(dated).toHaveLength(VISIT_LINES);
    expect(dated[0].at).toBe("2026-10-04T09:28:13.195Z");
    expect(lines.at(-1)!.kind).toBe(`visited the brand's website ${VISIT_LINES + 3} time(s) since 2026-10-01`);
  });

  it("the brand's own CRM filing says how the CRM classes them; our outreach follows, oldest first", () => {
    const lines = threadLinesOf(
      [{ type: "added_to_crm", source: "gohighlevel", occurred_at: "2026-06-04T19:09:57.280Z", payload: { contactType: "lead", leadSource: null, origin: "csv_import" } }],
      [{ label: "initial_email", occurred_at: "2026-10-01T00:00:00.000Z", source: "instantly" }],
    );
    expect(lines[0]).toMatchObject({ kind: "added_to_crm", detail: { contactType: "lead", origin: "csv_import" } });
    expect(lines[1]).toMatchObject({ source: "our_outreach:instantly", kind: "initial_email" });
  });

  it("a long URL is cut, never the whole query string", () => {
    const long = { ...visit(24), payload: { firstUrl: `https://x.io/?q=${"a".repeat(1000)}` } };
    expect(String(threadLinesOf([long], [])[0].detail!.firstUrl).length).toBe(300);
    expect(fitThread(threadLinesOf([long], [])).length).toBe(2);
  });
});

describe("the prospect question", () => {
  it("coming toward the brand is the prospect signal; a no needs the thread to show something else", () => {
    expect(TAG_QUESTIONS.prospect.instructions).toMatch(/visited its website/);
    expect(TAG_QUESTIONS.prospect.instructions).toMatch(/CRM files them/);
    expect(TAG_QUESTIONS.prospect.whenFalse).toMatch(/something else to the brand/);
    // The sentence that licensed "thin thread = unlikely" is gone.
    expect(JSON.stringify(TAG_QUESTIONS.prospect)).not.toMatch(/Nothing ties them/);
  });
});
