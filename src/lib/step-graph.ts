/**
 * The ORDER between steps is the LEG GRAPH — nothing else.
 *
 * A step is a place a lead can stand (replied with interest, visited the site, booked a meeting,
 * paid). A LEG is moving a lead from one step to the next, and a campaign is (offer x leg x channel).
 * The fleet's legs are the only order that exists between steps: one leg belongs to several ways of
 * selling at once (a booked meeting becomes an attended one whether the booking came off a reply or
 * off a site visit), so no single ordered list can say what comes "before" or "after" a step for
 * every lead. The graph can, and it says exactly as much as is true:
 *
 *   - an OUTCOME on a step means every step that EVERY path to it passes through was reached. A lead
 *     who attended a meeting booked one; a lead who signed up visited the site. A lead who paid did
 *     not necessarily book anything (a reply can close on its own), so paying implies nothing.
 *   - a NEVER on a step means every step that can ONLY be reached through it never happens. A lead
 *     who will never book will never attend; one who never visits the site never signs up.
 *
 * A step neither rule reaches stays pending — the honest "still on its way".
 *
 * THE LEGS ARE THE FLEET'S, IN THIS SERVICE'S STEP VOCABULARY. features-service mints the leg keys
 * (`<from>_to_<to>`, a published contract campaigns and budgets are keyed on) and brand-service lists
 * the same legs for its per-leg conversion rates. This table is the one place that translates them
 * into the step names statements are made in (`form_submitted` is `form_submission` here, `paid_client`
 * is `sale`), and a leg key is only ever LOOKED UP, never split into its parts. Two steps of the graph
 * are not statable here and exist only as places a path goes through: `conversation` (a positive
 * reply, which the delivery layer measures) and `purchase` (the direct-purchase rung, which ends in
 * `sale`).
 */
import { LEAD_STEP_OUTCOMES, type LeadStepOutcomeName } from "./step-statements.js";

/** A node of the leg graph, in the fleet's leg vocabulary. */
export type GraphStep =
  | "conversation"
  | "website_visit"
  | "meeting_booked"
  | "meeting_attended"
  | "signup"
  | "form_submitted"
  | "purchase"
  | "paid_client";

export interface Leg {
  legKey: string;
  /** null = "from nothing": this leg puts a lead on the graph. */
  from: GraphStep | null;
  to: GraphStep;
}

/** Every leg the fleet knows, keyed exactly as campaign-service stores `legKey`. */
export const LEGS: readonly Leg[] = [
  { legKey: "start_to_conversation", from: null, to: "conversation" },
  { legKey: "start_to_website_visit", from: null, to: "website_visit" },
  { legKey: "start_to_meeting_booked", from: null, to: "meeting_booked" },
  { legKey: "start_to_form_submitted", from: null, to: "form_submitted" },
  { legKey: "conversation_to_meeting_booked", from: "conversation", to: "meeting_booked" },
  { legKey: "conversation_to_paid_client", from: "conversation", to: "paid_client" },
  { legKey: "website_visit_to_meeting_booked", from: "website_visit", to: "meeting_booked" },
  { legKey: "website_visit_to_signup", from: "website_visit", to: "signup" },
  { legKey: "website_visit_to_form_submitted", from: "website_visit", to: "form_submitted" },
  { legKey: "website_visit_to_purchase", from: "website_visit", to: "purchase" },
  { legKey: "meeting_booked_to_meeting_attended", from: "meeting_booked", to: "meeting_attended" },
  { legKey: "meeting_attended_to_paid_client", from: "meeting_attended", to: "paid_client" },
  { legKey: "signup_to_paid_client", from: "signup", to: "paid_client" },
  { legKey: "form_submitted_to_paid_client", from: "form_submitted", to: "paid_client" },
  { legKey: "purchase_to_paid_client", from: "purchase", to: "paid_client" },
];

/**
 * Spellings minted before two form steps merged into `form_submitted` (2026-09-18). A stored
 * campaign row can still carry one; they are accepted on the way in and never emitted.
 */
const LEGACY_LEG_KEYS: Readonly<Record<string, string>> = {
  website_visit_to_form_filled: "website_visit_to_form_submitted",
  form_filled_to_paid_client: "form_submitted_to_paid_client",
  start_to_lead_form_submitted: "start_to_form_submitted",
  lead_form_submitted_to_paid_client: "form_submitted_to_paid_client",
};

const LEGS_BY_KEY = new Map(LEGS.map((l) => [l.legKey, l]));

/** The leg a stored `legKey` names, or null when it names none this service knows. */
export function legOf(value: unknown): Leg | null {
  if (typeof value !== "string") return null;
  return LEGS_BY_KEY.get(value) ?? LEGS_BY_KEY.get(LEGACY_LEG_KEYS[value] ?? "") ?? null;
}

const GRAPH_STEP_OF: Readonly<Record<LeadStepOutcomeName, GraphStep>> = {
  website_visit: "website_visit",
  signup: "signup",
  form_submission: "form_submitted",
  meeting_booked: "meeting_booked",
  meeting_attended: "meeting_attended",
  sale: "paid_client",
};

const STATABLE_OF: Readonly<Partial<Record<GraphStep, LeadStepOutcomeName>>> = Object.fromEntries(
  Object.entries(GRAPH_STEP_OF).map(([statable, node]) => [node, statable]),
) as Partial<Record<GraphStep, LeadStepOutcomeName>>;

/** The statable step a graph node is, or null for a step nothing here states. */
export function statableStepOf(node: GraphStep): LeadStepOutcomeName | null {
  return STATABLE_OF[node] ?? null;
}

const START = "start" as const;
type Node = GraphStep | typeof START;

const OUT = new Map<Node, GraphStep[]>();
for (const leg of LEGS) {
  const from: Node = leg.from ?? START;
  const list = OUT.get(from);
  if (list) list.push(leg.to);
  else OUT.set(from, [leg.to]);
}

function reachableFrom(root: Node, removed: Node | null): Set<Node> {
  const seen = new Set<Node>();
  if (root === removed) return seen;
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of OUT.get(node) ?? []) if (next !== removed && !seen.has(next)) stack.push(next);
  }
  return seen;
}

/**
 * For every statable step, the OTHER statable steps every path from "start" to it passes through
 * — computed once off the legs, never written by hand.
 */
const REQUIRED_BEFORE: ReadonlyMap<LeadStepOutcomeName, readonly LeadStepOutcomeName[]> = (() => {
  const out = new Map<LeadStepOutcomeName, LeadStepOutcomeName[]>();
  for (const step of LEAD_STEP_OUTCOMES) {
    const node = GRAPH_STEP_OF[step];
    const required: LeadStepOutcomeName[] = [];
    for (const other of LEAD_STEP_OUTCOMES) {
      if (other === step) continue;
      if (!reachableFrom(START, GRAPH_STEP_OF[other]).has(node)) required.push(other);
    }
    out.set(step, required);
  }
  return out;
})();

/** The statable steps every path to `step` goes through (not including `step` itself). */
export function stepsRequiredBefore(step: LeadStepOutcomeName): readonly LeadStepOutcomeName[] {
  return REQUIRED_BEFORE.get(step) ?? [];
}

/** The statable steps that can only be reached THROUGH `step` (not including `step` itself). */
export function stepsOnlyThrough(step: LeadStepOutcomeName): LeadStepOutcomeName[] {
  return LEAD_STEP_OUTCOMES.filter((other) => stepsRequiredBefore(other).includes(step));
}

/** Longest path from "start" — how deep on the graph a step sits. The graph has no cycles. */
const DEPTH: ReadonlyMap<Node, number> = (() => {
  const depth = new Map<Node, number>([[START, 0]]);
  const visit = (node: Node): number => {
    const known = depth.get(node);
    if (known !== undefined) return known;
    let best = -Infinity;
    for (const leg of LEGS) {
      if (leg.to !== node) continue;
      best = Math.max(best, visit(leg.from ?? START) + 1);
    }
    depth.set(node, best);
    return best;
  };
  for (const leg of LEGS) visit(leg.to);
  return depth;
})();

/**
 * Every statable step, shallowest first (ties in this service's canonical step order). This is the
 * order a response lists steps in and the order "deepest reached" is read in.
 */
export const STEP_ORDER: readonly LeadStepOutcomeName[] = [...LEAD_STEP_OUTCOMES].sort(
  (a, b) =>
    DEPTH.get(GRAPH_STEP_OF[a])! - DEPTH.get(GRAPH_STEP_OF[b])! ||
    LEAD_STEP_OUTCOMES.indexOf(a) - LEAD_STEP_OUTCOMES.indexOf(b),
);

/** The step every path ends at: somebody who reached it bought. */
export const TERMINAL_STEP: LeadStepOutcomeName = "sale";

/**
 * Where a campaign's leads step ONTO the graph, and whether this service can observe it.
 *
 * It is the step the campaign's own LEG works from: the `to` of an entry leg (the campaign puts
 * leads there), the `from` of an internal leg (the campaign picks leads up there). What it means
 * for the lead's standing:
 *
 *   - `conversation` is reached by REPLYING with interest, which the delivery layer classifies.
 *   - `website_visit` is reached by LANDING on the site, which the delivery layer measures as a
 *     click on the email we sent.
 *   - any other entry (an ad delivering a booked meeting or a submitted form) is reached by
 *     something no signal here observes, so it is `null` — stated as unresolvable, never guessed.
 */
export type EntryMeasure = "delivery_click" | "positive_reply";

export interface LegEntry {
  legKey: string;
  /** The step the campaign's leads enter at, in the graph's vocabulary (`conversation_reply` for a reply). */
  step: string;
  measure: EntryMeasure | null;
  /** Every statable step reachable from the entry, entry included, shallowest first. */
  reachableSteps: readonly LeadStepOutcomeName[];
}

const ENTRY_STEP_NAME: Readonly<Record<GraphStep, string>> = {
  conversation: "conversation_reply",
  website_visit: "website_visit",
  meeting_booked: "meeting_booked",
  meeting_attended: "meeting_attended",
  signup: "signup",
  form_submitted: "form_submission",
  purchase: "purchase",
  paid_client: "sale",
};

/** How a campaign working `leg` enters the graph. */
export function entryOfLeg(leg: Leg): LegEntry {
  const node = leg.from ?? leg.to;
  const reachable = reachableFrom(node, null);
  return {
    legKey: leg.legKey,
    step: ENTRY_STEP_NAME[node],
    measure:
      node === "conversation" ? "positive_reply" : node === "website_visit" ? "delivery_click" : null,
    reachableSteps: STEP_ORDER.filter((s) => reachable.has(GRAPH_STEP_OF[s])),
  };
}
