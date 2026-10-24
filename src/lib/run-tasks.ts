/**
 * EVERY RUN LEAD-SERVICE OPENS STATES WHAT ITS SPEND IS FOR (COST-SUPPORT-1024-LEAD, owner 2026-10-24; doctrine:
 * agent-config `cost-accounting`). runs-service reads coverage = declared outcome spend / (ledger - support): a run that
 * spends and neither declares an outcome nor is marked support is UNDECLARED spend.
 *
 * One entry per task name, one of three kinds:
 *   - `declares`: the run states the catalogue outcomes it produced (run-outcomes.ts builders), live and by backfill.
 *   - `support`: spend that produces no outcome by design, marked AT CREATION with its function (runs-service
 *     `support` on run create, never after: a run is never an instant unmarked). The function list is runs-service's.
 *   - `spendsNothing`: the run carries no cost of its own nor of a child (what it pays is billed elsewhere), so it
 *     never sits in undeclared spend.
 *   - `undeclared`: PRODUCTION work that spends and declares no outcome yet (the reason says why): its spend stays
 *     visible as undeclared, never hidden under a support mark.
 * `createRun` / `createPlatformRun` refuse a task named nowhere here unless the caller states `support` itself: a staff
 * benchmark or probe script (2026-10-21: eight `image-judge-bench-*` runs, $7.78 of judgments stated nothing) is a
 * `staff_experiment` from its first second. A new spending task is added here with its kind, or it cannot open a run.
 */

export const SUPPORT_FUNCTIONS = [
  "payment_fees",
  "brand_setup",
  "copilot",
  "platform_llm",
  "staff_experiment",
  "product_feature",
  "retired_product",
] as const;
export type SupportFunction = (typeof SUPPORT_FUNCTIONS)[number];

export interface RunSupport {
  kind: SupportFunction;
  reason: string;
}

export type RunTaskKind =
  | { declares: readonly string[] }
  | { support: RunSupport }
  | { spendsNothing: string }
  | { undeclared: string };

export const RUN_TASKS = {
  "lead-serve": { declares: ["lead_found"] },
  "company-research": { declares: ["company_researched"] },
  "qualification-sample": { declares: ["company_researched"] },
  "qualification-preview": { declares: ["company_researched"] },
  "outcome-recording": { declares: ["website_visit", "signup", "form_submitted", "purchase", "meeting_booked", "meeting_attended", "paid_client"] },
  "qualification-suggestions": {
    support: {
      kind: "product_feature",
      reason: "Drafts an offer's qualification criteria (a setup step of the offer): writes criteria, researches no company, finds no lead.",
    },
  },
  "rejudge-screenshot-checks": {
    support: {
      kind: "staff_experiment",
      reason: "One-time staff re-judgment of stored screenshot verdicts under a new judge (screenshot-rejudge.ts).",
    },
  },
  "followup-claim-relationship-judgment": {
    support: {
      kind: "platform_llm",
      reason: "Platform-billed relationship judgments a follow-up claim asks for on demand (no org request opens it).",
    },
  },
  "relationship-sweep": {
    undeclared:
      "Its Jev judgments (relationship tags, wants business) ride this run (chat-service platform judgments with x-run-id, PLATFORM-CALLER-RUN-1024). " +
      "Production work, never support; the outcome it feeds (lead identified) is crm-service's to declare, so its spend reads undeclared until one is.",
  },
} as const satisfies Record<string, RunTaskKind>;

export type RunTaskName = keyof typeof RUN_TASKS;

/**
 * The `support` a run of this task is created with: the registry's, else the caller's own. Throws on a task the
 * registry does not name when the caller states nothing (never an unclassified run).
 */
export function runSupportFor(taskName: string, stated?: RunSupport): RunSupport | undefined {
  const entry = (RUN_TASKS as Record<string, RunTaskKind>)[taskName];
  if (!entry) {
    if (stated) return stated;
    throw new Error(
      `[lead-service] run task "${taskName}" is not classified (src/lib/run-tasks.ts): add it with what it declares, or state its support function (a staff benchmark is staff_experiment)`,
    );
  }
  if (stated) throw new Error(`[lead-service] run task "${taskName}" is classified in run-tasks.ts: its support is the registry's, never restated by a caller`);
  return "support" in entry ? entry.support : undefined;
}
