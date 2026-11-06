/**
 * ONE lead vocabulary (LEAD-GENERIC-1106, owner 2026-11-06: "on parle encore de Lead. Lead won, lead lost"). The LEAD
 * (a person at a company, at a brand: the Unibox row) is a business concept the GTM factory keeps hard-coded with a
 * small fixed set of attributes; everything between steps (outcomes, Engines, scripts, channels) stays generic.
 *
 * A lead is described by exactly these, all read off the Unibox row (unibox-model.ts) + the lead's one next follow-up
 * date (lead-followup-date.ts):
 *   lifecycle      the ONE ladder (features-service catalogue: each step states its rung; the lead's rung = the highest
 *                  rung of any step it reached). No step-type list here decides a rung.
 *   reachable      contactable / unsubscribed / bounced / do_not_contact
 *   conversation   waiting_on_us / waiting_on_them / no_reply_yet / closed
 *   fit            fit / wrong_person / not_our_target (+ free note)
 *   interest       interested / not_interested / unsure / not_asked
 *   clientStatus   prospect / customer / churned
 *   nextFollowupAt the lead's one next follow-up date (null = none yet, or stopped: see nextFollowupBasis)
 * and three business concepts, each defined ONCE, here (Pure, `leadVerdictOf`; its SQL twin `leadVerdictSql` filters and
 * counts the same set):
 *   won   = Lifecycle on the ladder's TOP rung (Paid client today; the catalogue says which rung is the top).
 *   lost  = not won, and not reachable, wrong fit or not interested. The reasons are served, never a bare "lost".
 *   hot   = interested, not won, not lost (an interested person we may not write to, or who is the wrong fit, is lost:
 *           nobody can work them).
 * won / hot / lost are disjoint; a lead in none of them is simply open. "Cold" does not exist (the next follow-up date
 * covers it). Standing, buckets, sales-interest stage and the interest ladder are the OLD vocabulary: still served on
 * their reads until every consumer moved, never computed by a new path.
 */
import { sql } from "drizzle-orm";
import type {
  LifecycleRung,
  UniboxContactability,
  UniboxConversation,
  UniboxFit,
  UniboxInterest,
  UniboxStatus,
} from "./unibox-dimensions.js";

export const LEAD_VERDICTS = ["won", "hot", "lost"] as const;
export type LeadVerdict = (typeof LEAD_VERDICTS)[number];

export const LOST_REASONS = ["not_reachable", "wrong_fit", "not_interested"] as const;
export type LostReason = (typeof LOST_REASONS)[number];

export interface LeadLost {
  /** Every reason that holds, strongest first: not reachable, wrong fit, not interested. Never empty. */
  reasons: LostReason[];
  /** The value that made each reason: the reachability (e.g. `bounced`) and the fit (e.g. `not_our_target`). */
  reachable: UniboxContactability | null;
  fit: UniboxFit | null;
}

export interface LeadState {
  lifecycle: LifecycleRung | null;
  won: boolean;
  hot: boolean;
  lost: LeadLost | null;
  reachable: UniboxContactability;
  conversation: UniboxConversation;
  fit: UniboxFit;
  fitNote: string | null;
  interest: UniboxInterest;
  clientStatus: UniboxStatus;
  nextFollowupAt: string | null;
  /** How the date was set (`default`, `send`, `stated`, `served`, `not_yet`, `stop_recheck`, `stopped`); null = no date row yet. */
  nextFollowupBasis: string | null;
}

/** The ladder's top rung (null = empty ladder: nobody can be won). */
export function topRungRank(ladder: readonly LifecycleRung[]): number | null {
  return ladder.length === 0 ? null : Math.max(...ladder.map((r) => r.rank));
}

export interface LeadVerdictInput {
  lifecycleRank: number | null;
  reachable: UniboxContactability;
  fit: UniboxFit;
  interest: UniboxInterest;
}

/** Won / hot / lost, one definition (see the module comment). Pure. */
export function leadVerdictOf(x: LeadVerdictInput, topRank: number | null): { won: boolean; hot: boolean; lost: LeadLost | null } {
  const won = topRank !== null && x.lifecycleRank !== null && x.lifecycleRank >= topRank;
  if (won) return { won, hot: false, lost: null };
  const reasons: LostReason[] = [];
  if (x.reachable !== "contactable") reasons.push("not_reachable");
  if (x.fit !== "fit") reasons.push("wrong_fit");
  if (x.interest === "not_interested") reasons.push("not_interested");
  const lost: LeadLost | null =
    reasons.length === 0
      ? null
      : { reasons, reachable: x.reachable !== "contactable" ? x.reachable : null, fit: x.fit !== "fit" ? x.fit : null };
  return { won, hot: lost === null && x.interest === "interested", lost };
}

export function leadStateOf(
  row: {
    lifecycle: LifecycleRung | null;
    contactability: UniboxContactability;
    conversation: UniboxConversation;
    fit: UniboxFit;
    fitNote: string | null;
    interest: UniboxInterest;
    status: UniboxStatus;
  },
  ladder: readonly LifecycleRung[],
  nextFollowup: { at: string | null; basis: string } | null,
): LeadState {
  const verdict = leadVerdictOf(
    { lifecycleRank: row.lifecycle?.rank ?? null, reachable: row.contactability, fit: row.fit, interest: row.interest },
    topRungRank(ladder),
  );
  return {
    lifecycle: row.lifecycle,
    ...verdict,
    reachable: row.contactability,
    conversation: row.conversation,
    fit: row.fit,
    fitNote: row.fitNote,
    interest: row.interest,
    clientStatus: row.status,
    nextFollowupAt: nextFollowup?.at ?? null,
    nextFollowupBasis: nextFollowup?.basis ?? null,
  };
}

/** SQL twin of `leadVerdictOf` over `unibox_rows u`: true when the row is in the verdict. */
export function leadVerdictSql(verdict: LeadVerdict, topRank: number | null) {
  const won = topRank === null ? sql`false` : sql`coalesce(u.lifecycle_rank >= ${topRank}, false)`;
  const lostAny = sql`(u.contactability <> 'contactable' OR u.fit <> 'fit' OR u.interest = 'not_interested')`;
  if (verdict === "won") return won;
  if (verdict === "lost") return sql`(NOT ${won} AND ${lostAny})`;
  return sql`(NOT ${won} AND NOT ${lostAny} AND u.interest = 'interested')`;
}

/**
 * The lead's next follow-up date at the brand, over the row's leads (one lead almost always): the earliest dated one,
 * else a stopped one. Evaluated per `unibox_rows u` row inside a page statement. JSON `{at, basis}` or NULL.
 */
export const nextFollowupJsonSql = sql`(
  SELECT json_build_object('at', d.next_followup_at, 'basis', d.basis)
  FROM lead_followup_dates d
  WHERE d.org_id = u.org_id AND d.brand_id = u.brand_id AND d.lead_id = ANY(u.lead_ids)
  ORDER BY d.next_followup_at ASC NULLS LAST, d.lead_id
  LIMIT 1
)`;
