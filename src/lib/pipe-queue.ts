/**
 * WHO WAITS ON A PIPE, and how many it moved per week (FACTORY-P4-PAGES: the dashboard's staff
 * "Done by your team" page, one card per `your-team-*` pipe of the offer: meetings to attend,
 * calls to close...). Generic over any pipe: the caller names the pipe's leg as two catalogue
 * steps (`from`, `to`, features-service `stepTransitions[]`), never a pipe or channel slug here.
 *
 * Read off the lead STATES (lead-states.ts, LEAD-STATES-1024), through features-service's own
 * step -> state map (never re-mapped): a lead WAITS on the pipe when it reached the `from` step's
 * state, has not reached the `to` step's state, and nobody stated it never will (a live "won't
 * happen" on the `to` step). Its wait starts at its first reach of the `from` state. The pipe's
 * THROUGHPUT is, per ISO week (Monday, UTC), the leads that first reached the `to` state having
 * reached the `from` state first (or at the same instant). A step whose catalogue row reaches no
 * state cannot be read this way: the answer says so (`unservedReason`), never an empty list.
 */
import type { LeadStateCatalogue, LeadStates } from "./lead-states.js";

export type PipeQueueUnservedReason = "from_step_has_no_state" | "to_step_has_no_state";

export interface PipeQueueLeadState {
  leadId: string;
  states: LeadStates;
}

export interface PipeQueueWaiting {
  leadId: string;
  /** First reach of the `from` state (ISO), null when reached at an unknown date. */
  waitingSince: string | null;
  causedByOutreach: boolean | null;
}

export interface PipeQueueComputed {
  fromState: string | null;
  toState: string | null;
  unservedReason: PipeQueueUnservedReason | null;
  /** Oldest wait first; an undated wait last. */
  waiting: PipeQueueWaiting[];
  /** Per ISO week (Monday, YYYY-MM-DD), from the first week anyone moved to the last, every week listed. */
  throughput: Array<{ week: string; moved: number }>;
}

/** Monday (UTC) of the week holding `iso`, YYYY-MM-DD. */
export function isoWeekStart(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

const addWeek = (week: string) => new Date(Date.parse(`${week}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);

/**
 * Pure: the pipe's queue and weekly throughput from the brand's lead states. `neverOnTo` = leads with
 * a live "won't happen" on the `to` step; `untilWeek` closes the series (the current week, so a quiet
 * last stretch reads as zeros rather than ending early).
 */
export function computePipeQueue(input: {
  from: string;
  to: string;
  catalogue: LeadStateCatalogue;
  leads: readonly PipeQueueLeadState[];
  neverOnTo: ReadonlySet<string>;
  untilWeek: string;
}): PipeQueueComputed {
  const fromState = input.catalogue.get(input.from)?.state ?? null;
  const toState = input.catalogue.get(input.to)?.state ?? null;
  if (!fromState) return { fromState, toState, unservedReason: "from_step_has_no_state", waiting: [], throughput: [] };
  if (!toState) return { fromState, toState, unservedReason: "to_step_has_no_state", waiting: [], throughput: [] };

  const waiting: PipeQueueWaiting[] = [];
  const moved = new Map<string, number>();
  for (const l of input.leads) {
    const from = l.states[fromState as keyof LeadStates] ?? null;
    const to = l.states[toState as keyof LeadStates] ?? null;
    if (!from) continue;
    if (!to) {
      if (!input.neverOnTo.has(l.leadId)) waiting.push({ leadId: l.leadId, waitingSince: from.reachedAt, causedByOutreach: from.causedByOutreach });
      continue;
    }
    // Moved through THIS pipe: reached `to` after (or as) it reached `from`, both dated.
    if (to.reachedAt && from.reachedAt && Date.parse(to.reachedAt) >= Date.parse(from.reachedAt)) {
      const w = isoWeekStart(to.reachedAt);
      moved.set(w, (moved.get(w) ?? 0) + 1);
    }
  }
  waiting.sort((a, b) => {
    if (a.waitingSince === null) return b.waitingSince === null ? a.leadId.localeCompare(b.leadId) : 1;
    if (b.waitingSince === null) return -1;
    return Date.parse(a.waitingSince) - Date.parse(b.waitingSince) || a.leadId.localeCompare(b.leadId);
  });
  const throughput: Array<{ week: string; moved: number }> = [];
  const first = [...moved.keys()].sort()[0];
  if (first) for (let w = first; w <= input.untilWeek; w = addWeek(w)) throughput.push({ week: w, moved: moved.get(w) ?? 0 });
  return { fromState, toState, unservedReason: null, waiting, throughput };
}
