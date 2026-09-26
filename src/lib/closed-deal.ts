/**
 * THE DEAL, on a lead's row: it closed, what it was worth, what it cost the customer — and WHOSE
 * win it was.
 *
 * Every path of the leg graph ends at `sale`, so "did this person buy" is one step's
 * state and nothing more. What was missing is the last field: a brand contacts people through us
 * AND through everything else it already does — referrals, conferences, an existing pipeline,
 * another agency — so some of the people we email go on to buy for reasons that have nothing to do
 * with us. A deal like that is a REAL closed deal (recorded, counted among the brand's own, never
 * a refusal and never a lesser statement), but a consumer computing the return on OUR outreach has
 * to be able to leave its value out, and until `causedByOutreach` existed it could not tell the two
 * apart at all.
 *
 * It is DERIVED ON READ from the step states the lead already resolves, exactly as the standing is:
 * nothing is stored per row, so withdrawing or restating the statement moves this with it, with no
 * write and no backfill.
 *
 * Only a STATED sale answers here. An implied one carries no author, no value and no date because
 * nobody made that statement — and no step comes after `sale` on the leg graph, so an implied sale cannot
 * arise in the first place.
 */
import type { StepReadState } from "./step-states.js";
import type { StatementSource } from "./step-statements.js";

/** The `sale` step: every path of the leg graph ends there. */
export const SALE_STEP = "sale" as const;

export interface ClosedDeal {
  /** When the deal closed, ISO-8601. Null only when genuinely undated — never fabricated. */
  occurredAt: string | null;
  /** What it was worth, in cents. A sale stated from now on always carries one. */
  valueCents: number | null;
  /** What the CUSTOMER states closing it cost THEM. 0 is a stated zero; null is "nobody asked". */
  costCents: number | null;
  /**
   * WHOSE win it was. `true` — the customer says our outreach caused it. `false` — they say
   * something else of theirs did; the deal is still real and still theirs, it is simply not ours to
   * count a return on. `null` — NOBODY WAS ASKED: every deal stated before this existed, and every
   * tracker-reported one, because a page-load tag cannot know why somebody bought. Null is never
   * read as either answer.
   */
  causedByOutreach: boolean | null;
  /** `manual` — a human stated it; `tracker` — the website tag reported it. */
  source: StatementSource;
}

/**
 * The closed deal on this lead, or null when nobody has stated one.
 *
 * Reads the SAME `steps` the panel reads, so the row and the panel cannot disagree about whether a
 * person bought or about who caused it.
 */
export function closedDealFrom(steps: readonly StepReadState[]): ClosedDeal | null {
  const sale = steps.find((s) => s.step === SALE_STEP);
  if (!sale || sale.state !== "outcome" || sale.origin !== "stated" || !sale.source) return null;
  return {
    occurredAt: sale.at,
    valueCents: sale.valueCents,
    costCents: sale.costCents,
    causedByOutreach: sale.causedByOutreach,
    source: sale.source,
  };
}
