import type { BrandMembership } from "./audience-client.js";
import type { BuyingSignal } from "./buying-signal.js";

/**
 * WHAT ONE SOURCING PIPE FOUND AND WHAT WE KEPT, since inception (owner 2026-10-11, SRCPIPE-PEOPLE).
 *
 * A source pipe is a campaign-service campaign keyed (offer, origin slug, leg `start_to_lead_found`)
 * (src/lib/source-campaign.ts). Its people are read off facts already recorded, never off which
 * campaign a serve RUN was filed under (that only exists since #712, and only for one source per
 * serve):
 *
 *   - THE SOURCE'S AUDIENCES: every audience of the brand human-service records for the offer whose
 *     LIST KIND is one the origin counts (features-service `origins[].audienceLists`). An audience is
 *     the source's whatever campaign its serves were filed under, so serves before #712 count too.
 *   - FOUND by the source = every person one of its audiences surfaced to us:
 *       (a) a MEMBERSHIP of the audience (human-service: `served` = a serve under it handed the person
 *           out, `found_taken` = its search found them while the brand already had them), and
 *       (b) a candidate this service SCREENED for the audience (`candidate_screenings`, pass or
 *           reject) or declined on a must-pass check (`qualification_checks`, verdict no).
 *   - KEPT = found by the source AND served to an outreach campaign of the offer (a `served`
 *     `leads_campaigns` row): the person passed qualification and is worked by the funnel.
 *
 * MULTI PROVENANCE (owner rule): a person found by several sources counts in EACH source, never
 * first-found. `keptBy` says whether this source's own serve handed them out or another's did.
 *
 * NOT KEPT, every person once, first match wins: `screened_out` (our audience screen said no),
 * `failed_qualification_check` (a must-pass check said no), `kept_by_another_offer` (the brand
 * works them under another offer only), `not_served` (passed, but no serve came of it: no
 * deliverable email, or still pending). found = kept + the four.
 *
 * GAPS are served as counts with a reason, never guessed onto a source: a served row of the offer
 * with no audience (`no_audience`), an audience human-service states no list or offer for this person
 * (`audience_unattributed`), a lead with no registered email (`no_registered_email`, memberships key
 * on email), screenings on an audience human-service names nothing for (`screened_audience_unknown`,
 * brand scope: its offer is unknown too), and the source's kept people that human-service qualified
 * before handing them to us (`qualified_before_us`: their rejected peers are not in `found`).
 *
 * Pure: the loaders live in src/routes/source-people.ts.
 */

export interface SourceServeRow {
  leadId: string;
  campaignId: string;
  audienceId: string | null;
  status: string;
  /** When the person was served (served_at, else created_at), ISO-8601. */
  at: string;
  buyingSignal: BuyingSignal | null;
  apolloPersonId: string | null;
  emails: string[];
  companyDomain: string | null;
  companyName: string | null;
}

export interface SourceScreeningRow {
  audienceId: string;
  providerPersonId: string;
  verdict: string;
  at: string;
  companyDomain: string | null;
  companyName: string | null;
}

export interface SourceCheckDeclineRow {
  audienceId: string;
  providerPersonId: string;
  at: string;
  domain: string | null;
}

export interface SourcePeopleInput {
  offerId: string;
  lists: ReadonlySet<string>;
  /** The offer's OUTREACH campaigns (the lead rows' campaigns). */
  outreachCampaignIds: ReadonlySet<string>;
  /** Every lead row of the brand, any campaign, any status. */
  serves: SourceServeRow[];
  /** human-service memberships per email (the emails of `serves`). */
  membershipsByEmail: Map<string, BrandMembership[]>;
  screenings: SourceScreeningRow[];
  checkDeclines: SourceCheckDeclineRow[];
}

export const NOT_KEPT_REASONS = ["screened_out", "failed_qualification_check", "kept_by_another_offer", "not_served"] as const;
export type NotKeptReason = (typeof NOT_KEPT_REASONS)[number];

export const SOURCE_GAP_REASONS = [
  "no_audience",
  "audience_unattributed",
  "no_registered_email",
  "screened_audience_unknown",
  "qualified_before_us",
] as const;
export type SourceGapReason = (typeof SOURCE_GAP_REASONS)[number];

export interface SourceSignalCount {
  type: string;
  source: string;
  competitorPage: string | null;
  postUrl: string | null;
  people: number;
}

export interface SourceAudienceCount {
  audienceId: string;
  list: string;
  found: number;
  kept: number;
  screenedOut: number;
}

export interface SourcePeopleResult {
  found: { people: number; companies: number; peopleWithoutCompany: number };
  kept: { people: number; companies: number; peopleWithoutCompany: number; byThisSource: number; viaAnotherSource: number };
  notKept: Record<NotKeptReason, number>;
  daily: Array<{ day: string; found: number; kept: number }>;
  byAudience: SourceAudienceCount[];
  bySignal: SourceSignalCount[];
  keptWithoutSignal: number;
  gaps: Array<{ reason: SourceGapReason; people: number; scope: "offer" | "brand" | "source" }>;
  /** Kept people this source shares with at least one other source of the offer. */
  keptAlsoFoundByOtherSources: number;
}

const day = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`[source-people] unreadable timestamp ${iso}`);
  return d.toISOString().slice(0, 10);
};
const minIso = (a: string | null, b: string) => (a === null || new Date(b) < new Date(a) ? b : a);
const maxIso = (a: string, b: string) => (new Date(b) > new Date(a) ? b : a);
const domainKey = (d: string | null | undefined) => (d && d.trim() ? d.trim().toLowerCase().replace(/^www\./, "") : null);

interface PersonAcc {
  firstFoundAt: string | null;
  keptAt: string | null;
  kept: boolean;
  keptByThisSource: boolean;
  audiences: Set<string>;
  screenedOutAudiences: Set<string>;
  screenedOut: boolean;
  failedCheck: boolean;
  takenByAnotherOffer: boolean;
  company: string | null;
  signals: Set<string>;
  screenedHere: boolean;
  servedByThisSource: boolean;
  otherSourceLists: boolean;
}

export function computeSourcePeople(input: SourcePeopleInput): SourcePeopleResult {
  // ---- audiences: what human-service states each audience is (list, offer) ----
  const audienceInfo = new Map<string, { list: string | null; offerId: string | null }>();
  for (const ms of input.membershipsByEmail.values()) {
    for (const m of ms) audienceInfo.set(m.audienceId, { list: m.list, offerId: m.offerId });
  }
  const isOurs = (audienceId: string) => {
    const info = audienceInfo.get(audienceId);
    return !!info && info.offerId === input.offerId && info.list !== null && input.lists.has(info.list);
  };

  // ---- leads: rows grouped per person (lead) ----
  const leads = new Map<string, SourceServeRow[]>();
  for (const r of input.serves) {
    const rows = leads.get(r.leadId) ?? [];
    rows.push(r);
    leads.set(r.leadId, rows);
  }

  const people = new Map<string, PersonAcc>();
  const acc = (key: string): PersonAcc => {
    let p = people.get(key);
    if (!p) {
      p = {
        firstFoundAt: null, keptAt: null, kept: false, keptByThisSource: false, audiences: new Set(),
        screenedOutAudiences: new Set(), screenedOut: false, failedCheck: false, takenByAnotherOffer: false,
        company: null, signals: new Set(), screenedHere: false, servedByThisSource: false, otherSourceLists: false,
      };
      people.set(key, p);
    }
    return p;
  };

  const gapPeople: Record<SourceGapReason, Set<string>> = {
    no_audience: new Set(), audience_unattributed: new Set(), no_registered_email: new Set(),
    screened_audience_unknown: new Set(), qualified_before_us: new Set(),
  };
  const leadKeyByApolloId = new Map<string, string>();

  for (const [leadId, rows] of leads) {
    const key = `lead:${leadId}`;
    const apolloId = rows.find((r) => r.apolloPersonId)?.apolloPersonId ?? null;
    if (apolloId) leadKeyByApolloId.set(apolloId, key);

    const memberships = new Map<string, BrandMembership>();
    for (const r of rows) {
      for (const email of r.emails) {
        for (const m of input.membershipsByEmail.get(email) ?? []) {
          const k = `${m.audienceId}|${m.provenance}`;
          const prior = memberships.get(k);
          if (!prior || (m.joinedAt && prior.joinedAt && new Date(m.joinedAt) < new Date(prior.joinedAt))) memberships.set(k, m);
        }
      }
    }
    // Our own row is a fact too: a serve under an audience human-service describes is that
    // audience's `served` membership, even when its membership record is missing.
    for (const r of rows) {
      const info = r.audienceId ? audienceInfo.get(r.audienceId) : undefined;
      if (r.status !== "served" || !r.audienceId || !info) continue;
      const k = `${r.audienceId}|served`;
      const prior = memberships.get(k);
      if (!prior || (prior.joinedAt && new Date(r.at) < new Date(prior.joinedAt))) {
        memberships.set(k, { audienceId: r.audienceId, offerId: info.offerId, list: info.list, provenance: "served", joinedAt: r.at });
      }
    }
    const offerRows = rows.filter((r) => input.outreachCampaignIds.has(r.campaignId));
    const servedOffer = offerRows.filter((r) => r.status === "served");

    // Offer-scope gaps: a served row of the offer whose source cannot be named.
    for (const r of servedOffer) {
      const info = r.audienceId ? audienceInfo.get(r.audienceId) : undefined;
      if (!r.audienceId) gapPeople.no_audience.add(key);
      else if (info && info.list !== null && info.offerId !== null) continue;
      else if (r.emails.length === 0) gapPeople.no_registered_email.add(key);
      else gapPeople.audience_unattributed.add(key);
    }

    const ours = [...memberships.values()].filter((m) => isOurs(m.audienceId));
    if (ours.length === 0) continue;

    const p = acc(key);
    for (const m of ours) {
      if (!m.joinedAt) throw new Error(`[source-people] human-service membership without joinedAt (audience ${m.audienceId})`);
      p.firstFoundAt = minIso(p.firstFoundAt, m.joinedAt);
      p.audiences.add(m.audienceId);
    }
    p.otherSourceLists = [...memberships.values()].some(
      (m) => !isOurs(m.audienceId) && audienceInfo.get(m.audienceId)?.offerId === input.offerId,
    );
    const company = rows.find((r) => domainKey(r.companyDomain))?.companyDomain ?? null;
    p.company = domainKey(company);

    if (servedOffer.length > 0) {
      p.kept = true;
      const firstServed = servedOffer.reduce<string | null>((a, r) => minIso(a, r.at), null) as string;
      p.keptAt = maxIso(p.firstFoundAt as string, firstServed);
      const ourServes = servedOffer.filter((r) => r.audienceId && p.audiences.has(r.audienceId));
      p.keptByThisSource = ourServes.length > 0;
      p.servedByThisSource = p.keptByThisSource;
      for (const r of ourServes) {
        const s = r.buyingSignal;
        if (s) p.signals.add(JSON.stringify([s.type, s.source, s.engagement?.competitorPage ?? null, s.engagement?.postUrl ?? null]));
      }
    } else if (rows.some((r) => r.status === "served")) {
      p.takenByAnotherOffer = true;
    }
  }

  // ---- screenings and must-pass declines: candidates this service judged for the source ----
  const latestScreen = new Map<string, SourceScreeningRow & { first: string }>();
  for (const s of input.screenings) {
    if (!audienceInfo.has(s.audienceId)) {
      gapPeople.screened_audience_unknown.add(`pp:${s.providerPersonId}`);
      continue;
    }
    if (!isOurs(s.audienceId)) continue;
    const k = `${s.audienceId}|${s.providerPersonId}`;
    const prior = latestScreen.get(k);
    if (!prior) latestScreen.set(k, { ...s, first: s.at });
    else {
      const first = minIso(prior.first, s.at);
      latestScreen.set(k, new Date(s.at) > new Date(prior.at) ? { ...s, first } : { ...prior, first, companyDomain: prior.companyDomain ?? s.companyDomain });
    }
  }
  for (const s of latestScreen.values()) {
    const key = leadKeyByApolloId.get(s.providerPersonId) ?? `pp:${s.providerPersonId}`;
    const existed = people.has(key);
    const p = acc(key);
    p.screenedHere = true;
    p.firstFoundAt = minIso(p.firstFoundAt, s.first);
    p.audiences.add(s.audienceId);
    if (s.verdict === "reject") {
      p.screenedOutAudiences.add(s.audienceId);
      p.screenedOut = true;
    }
    if (!p.company) p.company = domainKey(s.companyDomain);
    if (!existed && key.startsWith("lead:")) {
      // A lead of the brand none of whose memberships is ours: found by this source's screen only.
      const rows = leads.get(key.slice(5)) ?? [];
      const servedOffer = rows.filter((r) => input.outreachCampaignIds.has(r.campaignId) && r.status === "served");
      if (servedOffer.length > 0) {
        p.kept = true;
        p.keptAt = maxIso(p.firstFoundAt as string, servedOffer.reduce<string | null>((a, r) => minIso(a, r.at), null) as string);
      } else if (rows.some((r) => r.status === "served")) p.takenByAnotherOffer = true;
      if (!p.company) p.company = domainKey(rows.find((r) => domainKey(r.companyDomain))?.companyDomain);
    }
  }
  for (const d of input.checkDeclines) {
    if (!isOurs(d.audienceId)) continue;
    const key = leadKeyByApolloId.get(d.providerPersonId) ?? `pp:${d.providerPersonId}`;
    const p = acc(key);
    p.failedCheck = true;
    p.firstFoundAt = minIso(p.firstFoundAt, d.at);
    p.audiences.add(d.audienceId);
    if (!p.company) p.company = domainKey(d.domain);
  }

  // ---- roll up ----
  const notKept: Record<NotKeptReason, number> = { screened_out: 0, failed_qualification_check: 0, kept_by_another_offer: 0, not_served: 0 };
  const daily = new Map<string, { found: number; kept: number }>();
  const bump = (d: string, f: "found" | "kept") => {
    const row = daily.get(d) ?? { found: 0, kept: 0 };
    row[f] += 1;
    daily.set(d, row);
  };
  const byAudience = new Map<string, SourceAudienceCount>();
  const signals = new Map<string, number>();
  const foundCompanies = new Set<string>();
  const keptCompanies = new Set<string>();
  let foundNoCompany = 0;
  let keptNoCompany = 0;
  let keptByThis = 0;
  let keptElsewhere = 0;
  let keptNoSignal = 0;
  let keptShared = 0;

  for (const [key, p] of people) {
    bump(day(p.firstFoundAt as string), "found");
    if (p.company) foundCompanies.add(p.company);
    else foundNoCompany += 1;
    for (const a of p.audiences) {
      const row = byAudience.get(a) ?? { audienceId: a, list: audienceInfo.get(a)?.list as string, found: 0, kept: 0, screenedOut: 0 };
      row.found += 1;
      if (p.kept) row.kept += 1;
      if (p.screenedOutAudiences.has(a)) row.screenedOut += 1;
      byAudience.set(a, row);
    }
    if (p.kept) {
      bump(day(p.keptAt as string), "kept");
      if (p.company) keptCompanies.add(p.company);
      else keptNoCompany += 1;
      if (p.keptByThisSource) keptByThis += 1;
      else keptElsewhere += 1;
      if (p.otherSourceLists) keptShared += 1;
      if (p.signals.size === 0) keptNoSignal += 1;
      for (const s of p.signals) signals.set(s, (signals.get(s) ?? 0) + 1);
      if (p.servedByThisSource && !p.screenedHere) gapPeople.qualified_before_us.add(key);
    } else if (p.screenedOut) notKept.screened_out += 1;
    else if (p.failedCheck) notKept.failed_qualification_check += 1;
    else if (p.takenByAnotherOffer) notKept.kept_by_another_offer += 1;
    else notKept.not_served += 1;
  }

  const keptPeople = keptByThis + keptElsewhere;
  return {
    found: { people: people.size, companies: foundCompanies.size, peopleWithoutCompany: foundNoCompany },
    kept: { people: keptPeople, companies: keptCompanies.size, peopleWithoutCompany: keptNoCompany, byThisSource: keptByThis, viaAnotherSource: keptElsewhere },
    notKept,
    daily: [...daily.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([d, c]) => ({ day: d, ...c })),
    byAudience: [...byAudience.values()].sort((a, b) => b.found - a.found || (a.audienceId < b.audienceId ? -1 : 1)),
    bySignal: [...signals.entries()]
      .map(([k, people]) => {
        const [type, source, competitorPage, postUrl] = JSON.parse(k) as [string, string, string | null, string | null];
        return { type, source, competitorPage, postUrl, people };
      })
      .sort((a, b) => b.people - a.people || (a.source < b.source ? -1 : 1)),
    keptWithoutSignal: keptNoSignal,
    gaps: SOURCE_GAP_REASONS.map((reason) => ({
      reason,
      people: gapPeople[reason].size,
      scope: (reason === "screened_audience_unknown" ? "brand" : reason === "qualified_before_us" ? "source" : "offer") as "offer" | "brand" | "source",
    })),
    keptAlsoFoundByOtherSources: keptShared,
  };
}
