/**
 * runs-service's `GET /internal/outcome-occurrences` (direction produced) answered from a list of produced Units: what
 * `hasStandingProducedUnit` reads before a fact of ours states what it consumed (LATE-UNIT-LINK-1117). Applies the
 * read's own filters (subject service, subject ids, outcome key, `declaredBefore`). null = not that read.
 */
export interface FakeLedgerUnit {
  outcomeKey: string;
  subjectService: string;
  subjectId: string;
  /** Absent = declared at the beginning of time (before any fact). */
  declaredAt?: string;
  reversed?: boolean;
}

export function fakeLedgerOccurrences(url: string, units: readonly FakeLedgerUnit[]): Response | null {
  if (!url.includes("/internal/outcome-occurrences?")) return null;
  const q = new URL(url).searchParams;
  if (q.get("direction") !== "produced") return new Response("fake ledger serves produced occurrences only", { status: 400 });
  const subjectIds = (q.get("subjectIds") ?? "").split(",").filter(Boolean);
  const before = q.get("declaredBefore");
  const occurrences = units
    .filter((u) => u.subjectService === q.get("subjectService") && subjectIds.includes(u.subjectId))
    .filter((u) => !q.get("outcomeKey") || u.outcomeKey === q.get("outcomeKey"))
    .filter((u) => !before || !u.declaredAt || Date.parse(u.declaredAt) < Date.parse(before))
    .map((u) => ({
      outcomeKey: u.outcomeKey,
      subjectService: u.subjectService,
      subjectId: u.subjectId,
      direction: "produced",
      declaredAt: u.declaredAt ?? "1970-01-01T00:00:00.000Z",
      reversal: u.reversed ? { reversedAt: "2026-01-01T00:00:00.000Z", recordedAt: "2026-01-01T00:00:00.000Z", reason: "fake", reversedBy: "fake" } : null,
    }));
  return new Response(JSON.stringify({ occurrences, nextCursor: null }), { status: 200 });
}
