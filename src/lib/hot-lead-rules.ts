/**
 * "Hot lead" trigger — the pure rules (HOT-LEAD-PROPOSAL-1019, owner 2026-10-19: « crée une nouvelle campaign qui fait
 * que Sophie me notifie à chq fois qu'une lead non client non perso nous écrit avec de l'interest business »). The IO
 * is `hot-lead-triggers.ts`.
 *
 *  - HOT = this service's own two answers (relationship-intent.ts): `lead` yes AND `wantsBusiness` yes, any channel.
 *  - A FACT is a TRANSITION: a relation (human x company, the Unibox grain) seen not hot (or never seen) and now hot.
 *    Staying hot fires nothing (re-judgments, re-reads, restarts); hot -> not -> hot is a new fact (a new episode).
 *  - From now on: a brand's first pass records who is hot already and fires nothing (no history back-fill).
 *  - Never for the brand's own team (a member of the org owning the brand) nor a staff address.
 *  - "Not a client, not a personal contact" is NOT decided here: it is the answering pipe's lead strategy (`leads-only`).
 */
import { anyMemberAddress } from "./org-members.js";

/** The trigger id features-service declares (kind `reported`, reportedBy lead-service). */
export const HOT_LEAD_TRIGGER = "hot_lead";

/** How a fire row's `payload.item.kind` names the occurrence (handed to the workflow as `trigger.item`). */
export const HOT_LEAD_ITEM_KIND = "hot_lead";

export type HotTransition = "became_hot" | "stayed_hot" | "cooled" | "stays_cold";

/** What a pass does with one relation: `prior` = the stored answer (null = never seen), `now` = this pass's. */
export function hotTransition(prior: boolean | null, now: boolean): HotTransition {
  if (now) return prior === true ? "stayed_hot" : "became_hot";
  return prior === true ? "cooled" : "stays_cold";
}

/** Is the relation hot: lead yes AND wants business yes? */
export function isHot(answers: { lead: { state: string | null }; wantsBusiness: { state: string | null } }): boolean {
  return answers.lead.state === "yes" && answers.wantsBusiness.state === "yes";
}

/**
 * Staff, byte-equal with the fleet staff lists (crm-service / client-service / billing-service `isStaffEmail`, from
 * api-service STAFF_EMAILS), plus any `@distribute.you` address. Plus-addressing ignored.
 */
export const STAFF_EMAILS: readonly string[] = ["kevin.lourd@gmail.com", "kevin@distribute.you", "kevin@pressbeat.io"];
export const STAFF_DOMAIN = "@distribute.you";

export function isStaffEmail(email: string | null | undefined): boolean {
  const e = email?.trim().toLowerCase();
  if (!e || !e.includes("@")) return false;
  if (e.endsWith(STAFF_DOMAIN)) return true;
  const [local, domain] = e.split("@");
  return STAFF_EMAILS.includes(`${local.split("+")[0]}@${domain}`);
}

export type HotFireVerdict = { fire: true } | { fire: false; reason: "own_team" | "staff" };

/** May a new hot fact about a person with these addresses ring the door? */
export function hotFireVerdict(emails: readonly string[], members: ReadonlySet<string>): HotFireVerdict {
  if (emails.some((e) => isStaffEmail(e))) return { fire: false, reason: "staff" };
  if (anyMemberAddress(emails, members)) return { fire: false, reason: "own_team" };
  return { fire: true };
}

/**
 * campaign-service's idempotency key (unique per org, at most 200 chars): the trigger, the brand, the offer, the
 * relation and its episode. A replay of our own call answers the first event; a new episode is a new event.
 */
export function hotLeadIdempotencyKey(input: {
  brandId: string;
  offerId: string;
  humanId: string;
  companyKey: string;
  episode: number;
  hash: (s: string) => string;
}): string {
  const company = input.companyKey === "" ? "-" : input.hash(input.companyKey).slice(0, 16);
  return `lead-service:${HOT_LEAD_TRIGGER}:${input.brandId}:${input.offerId}:${input.humanId}:${company}:${input.episode}`;
}

/** What the occurrence carries to the answering workflow (`trigger.item`): who, and how we know they are hot. */
export interface HotLeadItem {
  kind: typeof HOT_LEAD_ITEM_KIND;
  humanId: string;
  companyKey: string;
  /** crm-service relation keys: open the person's thread with crm `/orgs/people/timeline?relationKey=`. */
  relationKey: string | null;
  relationKeys: string[];
  leadId: string | null;
  name: string | null;
  emails: string[];
  phones: string[];
  lead: { state: string | null; basis: string | null };
  wantsBusiness: { state: string | null; basis: string | null; confidence: number | null; at: string | null };
  lastInboundAt: string | null;
  becameHotAt: string;
  episode: number;
}
