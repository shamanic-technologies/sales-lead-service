/**
 * Which HTTP thread answers a request (see src/http-worker.ts).
 *
 * The `interactive` thread takes only the reads a person waits on in the dashboard: one bounded
 * page of leads, the tab and board counts, one lead, its history and its statements. Everything
 * else — every write, the serve path, every whole-population walk (`view=compact`, an unbounded
 * list, a CSV export, the change feed) and every `/internal` read — stays on the `general` thread,
 * exactly as one process served it before. Both threads run the same app, so a route answers the
 * same bytes on either; this decides only WHICH event loop it waits on.
 */
const LEAD_SINGLE_SEGMENT_NOT_A_LEAD = new Set([
  "changes",
  "crm-pairings",
  "crm-pairing-counts",
  "crm-evidence",
  "evidence-changed",
]);
const LEAD_COUNT_READS = new Set(["bucket-counts", "standing-counts", "conversation-counts"]);
const LEAD_SUB_READS = new Set(["history", "timeline", "step-statements", "qualification", "crm-attribution"]);

export function isInteractiveRead(method: string | undefined, url: string | undefined): boolean {
  if (method !== "GET" || !url) return false;
  const q = url.indexOf("?");
  const path = q === -1 ? url : url.slice(0, q);
  const params = new URLSearchParams(q === -1 ? "" : url.slice(q + 1));
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts[0] !== "orgs" || parts[1] !== "leads") return false;
  if (parts.length === 2) {
    // A bounded page a person looks at — never a walk of the whole population.
    return (
      params.has("limit") &&
      params.get("view") !== "compact" &&
      params.get("format") !== "csv" &&
      !params.has("include")
    );
  }
  if (parts.length === 3) {
    if (LEAD_COUNT_READS.has(parts[2])) return true;
    return !LEAD_SINGLE_SEGMENT_NOT_A_LEAD.has(parts[2]);
  }
  if (parts.length === 4) return LEAD_SUB_READS.has(parts[3]);
  return false;
}
