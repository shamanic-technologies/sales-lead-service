import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EMAIL_SEND_WORKFLOW_SOURCES, REPOINT_CAUSES } from "../../src/lib/repoint-causes.js";

vi.mock("../../src/db/index.js", () => ({ db: {}, sql: {} }));

const ROOT = join(__dirname, "..", "..");

function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? srcFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

/** Every literal cause a writer INSERTs into lead_campaign_run_repoints (VALUES (...) or SELECT ... FROM). */
function writtenCauses(): Set<string> {
  const causes = new Set<string>();
  for (const file of srcFiles(join(ROOT, "src"))) {
    const text = readFileSync(file, "utf8");
    const re = /INSERT INTO lead_campaign_run_repoints\s*\([^)]*\)\s*([\s\S]*?)(?:`\)|\n\s*\)\s*\n)/g;
    for (const m of text.matchAll(re)) {
      const lits = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      expect(lits, `${file}: a repoint INSERT must state its cause as a literal`).toHaveLength(1);
      causes.add(lits[0]);
    }
  }
  return causes;
}

/** The cause CHECK of the latest migration that (re)states it. */
function checkedCauses(): Set<string> {
  const dir = join(ROOT, "drizzle");
  let last: string[] | null = null;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
    const text = readFileSync(join(dir, f), "utf8");
    for (const m of text.matchAll(/cause[^\n]*CHECK \(cause IN \(([^)]*)\)\)/g)) {
      last = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    }
  }
  if (!last) throw new Error("no cause CHECK found in drizzle/");
  return new Set(last);
}

describe("lead_campaign_run_repoints causes (JOURNEYS-FOLLOWUP-DUE-1019)", () => {
  it("every cause a writer records is one the journeys reader accepts", () => {
    const written = writtenCauses();
    expect([...written].sort()).toEqual(["followup_due", "named_serve", "retry_claim"]);
    expect([...written].sort()).toEqual([...REPOINT_CAUSES].sort());
  });

  it("the table's CHECK is the same closed list", () => {
    expect([...checkedCauses()].sort()).toEqual([...REPOINT_CAUSES].sort());
  });

  it("the timeline journeys parse every source, followup_due included, and refuse an unknown one", async () => {
    const { toBrandJourney } = await import("../../src/lib/brand-journeys.js");
    const journey = (workflowSource: string | null) =>
      toBrandJourney({
        lead_id: "l1",
        offer_id: null,
        first_acted_at: null,
        facts: [],
        acts: [],
        email_sends: [
          { campaignId: "c1", workflowSlug: "wf-a", workflowSource, firstAt: null, lastAt: null, count: 1, transports: [] },
        ],
      });
    for (const s of EMAIL_SEND_WORKFLOW_SOURCES) {
      expect(journey(s).emailSends[0]).toMatchObject({ workflowSlug: "wf-a", workflowSource: s });
    }
    expect(journey(null).emailSends[0].workflowSource).toBeNull();
    expect(() => journey("bogus")).toThrow(/unknown email send workflow source/);
  });
});
