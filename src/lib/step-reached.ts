/**
 * WHO REACHED A STEP at a brand, and WHEN (FACT-NOT-FOLLOWED-1014, owner 2026-10-14: "a campaign that writes as
 * soon as a signup is not followed by a paid client within 30 min"). campaign-service's generic `delay` trigger
 * detector asks two questions in the features-service catalogue's STEP keys:
 *   - who reached step X since T, and when (it plans one occurrence per person, due X + delay);
 *   - has this email EVER reached step Y (just before writing: "still not Y").
 *
 * What a fact MEANS as a step is this service's (never re-mapped by a consumer). Two stores answer:
 *   1. the bronze copy of crm-service's people fact feed (`crm_facts`): the fact TYPE, never the tool that saw it
 *      (a Clerk, PostHog or platform signup is a signup; a PostHog session is a website visit; a payment reaches
 *      `paid_client` only when it STANDS: succeeded and not wholly refunded, `paymentStands`, the CRM evidence rule);
 *      a fact counts until a `withdrawn` fact names it;
 *   2. the outcome ledger (`conversion_events`: tracked, hand-stated, CRM, reply), live rows only (`withdrawn_at IS
 *      NULL`), in this service's statable vocabulary (`sale`/legacy `purchase` = `paid_client`, `form_submission` =
 *      `form_submitted`; a sale the brand's website tag reported is ALSO `purchase`, Direct purchase: bought on
 *      the site). The person is the event's own reported email, plus the matched lead's registered emails
 *      when the row is attributed.
 * This is "did the person reach the step", NOT a count: a measured visit and a hand-stated one are the same reach,
 * and no count's suppression or attribution rule applies.
 *
 * A person = a canonical (trimmed, lowercased) email. Reach rows sharing any email are ONE person (a CRM contact
 * with four addresses is one person, never four). A reach with no email is not returned: nobody can be written to.
 */
import { paymentStands } from "./crm-evidence.js";

/** One catalogue step this read can see, and what evidences it in each store. */
interface StepEvidence {
  /** crm-service fact types that reach the step. */
  crmFactTypes: readonly string[];
  /** Outcome ledger events (this service's stored spellings) that reach the step. */
  ledgerEvents: readonly string[];
  /**
   * Only ledger rows recorded by one of these sources reach the step (absent = any source). Direct purchase is
   * a sale the brand's WEBSITE TAG reported (`tracker`): the person bought on the site; a sale a person states
   * or a CRM syncs is a paid client, never a site checkout.
   */
  ledgerSources?: readonly string[];
}

/** The outcome ledger source written by the brand's website tag (the public conversion ingest). */
export const SITE_TAG_SOURCE = "tracker";

/** crm-service's fact for money a person paid: reaches `paid_client` only when it stands. */
const PAYMENT_FACT = "payment";

/** The catalogue steps this read answers, keyed in features-service's step vocabulary. */
export const STEP_REACHED_EVIDENCE: Readonly<Record<string, StepEvidence>> = {
  website_visit: { crmFactTypes: ["website_visit"], ledgerEvents: ["website_visit"] },
  signup: { crmFactTypes: ["signup"], ledgerEvents: ["signup"] },
  form_submitted: { crmFactTypes: ["form_submitted"], ledgerEvents: ["form_submission"] },
  meeting_booked: { crmFactTypes: ["meeting_booked"], ledgerEvents: ["meeting_booked"] },
  meeting_attended: { crmFactTypes: ["meeting_attended"], ledgerEvents: ["meeting_attended"] },
  paid_client: { crmFactTypes: ["sale", PAYMENT_FACT], ledgerEvents: ["sale", "purchase"] },
  purchase: { crmFactTypes: [], ledgerEvents: ["sale", "purchase"], ledgerSources: [SITE_TAG_SOURCE] },
};

/** Whether an outcome-ledger row (its stored event and source) reaches the step. */
export function ledgerRowReachesStep(step: string, event: string, source: string): boolean {
  const evidence = Object.prototype.hasOwnProperty.call(STEP_REACHED_EVIDENCE, step) ? STEP_REACHED_EVIDENCE[step] : null;
  if (!evidence || !evidence.ledgerEvents.includes(event)) return false;
  return !evidence.ledgerSources || evidence.ledgerSources.includes(source);
}

export const STEP_REACHED_STEPS: readonly string[] = Object.keys(STEP_REACHED_EVIDENCE);

/**
 * Catalogue steps this service knows (the leg graph) but whose reach no store here SEES per person by email:
 * a positive reply is measured by the delivery layer, `lead_found` is a serve, a social engagement has no email.
 * Asking for one is a named refusal, never an empty answer
 * (empty would read as "nobody reached it").
 */
export const STEP_REACHED_UNOBSERVED_STEPS: readonly string[] = [
  "lead_found",
  "conversation",
  "industry_update_video",
];

export type StepReachedRefusal =
  | { code: "unknown_step"; message: string }
  | { code: "step_not_observable"; message: string };

/** null when the step is answerable, else the named refusal. */
export function refuseStep(step: string): StepReachedRefusal | null {
  if (Object.prototype.hasOwnProperty.call(STEP_REACHED_EVIDENCE, step)) return null;
  if (STEP_REACHED_UNOBSERVED_STEPS.includes(step)) {
    return {
      code: "step_not_observable",
      message: `step "${step}" is a catalogue step whose reach this service cannot see per person; answerable: ${STEP_REACHED_STEPS.join(", ")}`,
    };
  }
  return {
    code: "unknown_step",
    message: `unknown step "${step}"; answerable: ${STEP_REACHED_STEPS.join(", ")}`,
  };
}

export function canonicalEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** One reach row, from either store, before it is grouped into people. */
export interface ReachRow {
  /** The person's addresses, in the store's order (a CRM fact lists the contact's own first). */
  emails: readonly string[];
  name: string | null;
  phones: readonly string[];
  /** ISO instant, or null for an undated reach. */
  at: string | null;
  /** The fact type / ledger event (`payment` is filtered on its payload). */
  type: string;
  payload: Record<string, unknown> | null;
}

export interface ReachedPerson {
  email: string;
  name: string | null;
  phone: string | null;
  /** Earliest dated reach in the window; null only when every reach of the person is undated (email mode). */
  reachedAt: string | null;
}

/** Whether a row is a reach at all (a payment that did not stand is money that did not stay). */
export function rowReaches(row: ReachRow): boolean {
  if (row.type === PAYMENT_FACT) return paymentStands(row.payload);
  return true;
}

function cleanEmails(emails: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of emails) {
    const c = canonicalEmail(e);
    if (c && c.includes("@") && !out.includes(c)) out.push(c);
  }
  return out;
}

function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

/**
 * Groups reach rows into people (rows sharing any email are one person), each with the earliest dated reach.
 * `askedEmail` (email mode): the person is named by that address. Otherwise the person is named by the first
 * address of their EARLIEST reach row. Name and phone: the latest dated row stating one, else any row stating one.
 * Sorted by reachedAt ascending (undated last), then email.
 */
export function groupReachedPeople(rows: readonly ReachRow[], askedEmail: string | null = null): ReachedPerson[] {
  const kept = rows
    .filter(rowReaches)
    .map((r) => ({ ...r, emails: cleanEmails(r.emails) }))
    .filter((r) => r.emails.length > 0);

  // Union-find over emails.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const r of kept) {
    for (const e of r.emails) if (!parent.has(e)) parent.set(e, e);
    for (const e of r.emails.slice(1)) {
      const a = find(r.emails[0]);
      const b = find(e);
      if (a !== b) parent.set(b, a);
    }
  }

  const groups = new Map<string, typeof kept>();
  for (const r of kept) {
    const root = find(r.emails[0]);
    const list = groups.get(root);
    if (list) list.push(r);
    else groups.set(root, [r]);
  }

  const people: ReachedPerson[] = [];
  for (const members of groups.values()) {
    let reachedAt: string | null = null;
    for (const m of members) reachedAt = earlier(reachedAt, m.at);
    const byTimeAsc = [...members].sort((a, b) => {
      if (a.at === null) return b.at === null ? 0 : 1;
      if (b.at === null) return -1;
      return Date.parse(a.at) - Date.parse(b.at);
    });
    const latestFirst = [...byTimeAsc].reverse();
    const name = latestFirst.find((m) => m.name && m.name.trim())?.name?.trim() ?? null;
    const phone = latestFirst.flatMap((m) => m.phones.map((p) => p.trim()).filter(Boolean))[0] ?? null;
    const email =
      askedEmail !== null && members.some((m) => m.emails.includes(askedEmail)) ? askedEmail : byTimeAsc[0].emails[0];
    people.push({ email, name, phone, reachedAt });
  }

  return people.sort((a, b) => {
    if (a.reachedAt !== b.reachedAt) {
      if (a.reachedAt === null) return 1;
      if (b.reachedAt === null) return -1;
      const d = Date.parse(a.reachedAt) - Date.parse(b.reachedAt);
      if (d !== 0) return d;
    }
    return a.email < b.email ? -1 : a.email > b.email ? 1 : 0;
  });
}
