/**
 * Flattening one email-gateway status answer down to the scope a read is about.
 *
 * email-gateway keys its evidence on the campaign that SENT, and answers a brand-mode question
 * with a per-campaign breakdown (`byCampaign`) beside the brand roll-up. Everything here is a way
 * of collapsing that answer: to the brand, to one campaign, to a campaign IDENTITY's members, or
 * to one campaign identity nested under a brand-scoped row (see campaign-breakdown.ts). Merging
 * across the two providers (broadcast + transactional) is common to all of them, which is why it
 * lives in one module rather than beside any one caller.
 */
import type {
  StatusResult,
  ProviderStatus,
  ScopedStatus,
  GlobalStatus,
} from "./email-gateway-client.js";

export interface FlattenedStatus {
  contacted: boolean;
  sent: boolean;
  delivered: boolean;
  opened: boolean;
  clicked: boolean;
  bounced: boolean;
  unsubscribed: boolean;
  replied: boolean;
  replyClassification: "positive" | "negative" | "neutral" | null;
  // Tri-state, deliberately: true = the provider reports this person as permanently out (the
  // wrong contact, or gone from the role); false = it looked and says no; undefined = nobody can
  // tell us (a provider without reply tracking, or a payload older than the field). Never
  // collapsed to a boolean — see `resolveLeadStanding`.
  disqualified?: boolean;
  sentCount: number;
  lastDeliveredAt: string | null;
  firstContactedAt: string | null;
  firstSentAt: string | null;
  firstDeliveredAt: string | null;
  firstOpenedAt: string | null;
  firstClickedAt: string | null;
  firstRepliedAt: string | null;
  firstBouncedAt: string | null;
  firstUnsubscribedAt: string | null;
  global: { bounced: boolean; unsubscribed: boolean };
}

/** First-occurrence (MIN) merge: earliest non-null ISO timestamp across providers. */
export function earliestIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a <= b ? a : b;
}

export function pickScoped(s: ScopedStatus | null | undefined) {
  return {
    contacted: !!s?.contacted,
    sent: !!s?.sent,
    delivered: !!s?.delivered,
    opened: !!s?.opened,
    clicked: !!s?.clicked,
    bounced: !!s?.bounced,
    unsubscribed: !!s?.unsubscribed,
    replied: !!s?.replied,
    replyClassification: s?.replyClassification ?? null,
    disqualified: s?.disqualified,
    sentCount: s?.sentCount ?? 0,
    lastDeliveredAt: s?.lastDeliveredAt ?? null,
    firstContactedAt: s?.firstContactedAt ?? null,
    firstSentAt: s?.firstSentAt ?? null,
    firstDeliveredAt: s?.firstDeliveredAt ?? null,
    firstOpenedAt: s?.firstOpenedAt ?? null,
    firstClickedAt: s?.firstClickedAt ?? null,
    firstRepliedAt: s?.firstRepliedAt ?? null,
    firstBouncedAt: s?.firstBouncedAt ?? null,
    firstUnsubscribedAt: s?.firstUnsubscribedAt ?? null,
  };
}

export function mergeGlobal(bc?: GlobalStatus | null, tx?: GlobalStatus | null) {
  return {
    bounced: !!(bc?.email?.bounced || tx?.email?.bounced),
    unsubscribed: !!(bc?.email?.unsubscribed || tx?.email?.unsubscribed),
  };
}

/**
 * OR across providers, but only over the providers that ANSWERED. A `true` from either one wins;
 * a `false` needs at least one provider to have looked; when neither serves the reading at all the
 * merge stays `undefined`, because "nobody can tell us" is not the same fact as "no".
 */
export function mergeDisqualified(
  a: boolean | undefined,
  b: boolean | undefined,
): boolean | undefined {
  if (a === true || b === true) return true;
  if (a === false || b === false) return false;
  return undefined;
}

export function mergeProviders(
  bcScope: ReturnType<typeof pickScoped>,
  txScope: ReturnType<typeof pickScoped>,
): Omit<FlattenedStatus, "global"> {
  return {
    contacted: bcScope.contacted || txScope.contacted,
    sent: bcScope.sent || txScope.sent,
    delivered: bcScope.delivered || txScope.delivered,
    opened: bcScope.opened || txScope.opened,
    clicked: bcScope.clicked || txScope.clicked,
    bounced: bcScope.bounced || txScope.bounced,
    unsubscribed: bcScope.unsubscribed || txScope.unsubscribed,
    replied: bcScope.replied || txScope.replied,
    replyClassification: bcScope.replyClassification ?? txScope.replyClassification ?? null,
    disqualified: mergeDisqualified(bcScope.disqualified, txScope.disqualified),
    // Broadcast (Instantly) and transactional (Postmark) are disjoint sending
    // channels, so the total emails sent to this lead = sum across providers.
    sentCount: bcScope.sentCount + txScope.sentCount,
    lastDeliveredAt: bcScope.lastDeliveredAt ?? txScope.lastDeliveredAt ?? null,
    firstContactedAt: earliestIso(bcScope.firstContactedAt, txScope.firstContactedAt),
    firstSentAt: earliestIso(bcScope.firstSentAt, txScope.firstSentAt),
    firstDeliveredAt: earliestIso(bcScope.firstDeliveredAt, txScope.firstDeliveredAt),
    firstOpenedAt: earliestIso(bcScope.firstOpenedAt, txScope.firstOpenedAt),
    firstClickedAt: earliestIso(bcScope.firstClickedAt, txScope.firstClickedAt),
    firstRepliedAt: earliestIso(bcScope.firstRepliedAt, txScope.firstRepliedAt),
    firstBouncedAt: earliestIso(bcScope.firstBouncedAt, txScope.firstBouncedAt),
    firstUnsubscribedAt: earliestIso(bcScope.firstUnsubscribedAt, txScope.firstUnsubscribedAt),
  };
}

export function flattenCampaignStatus(result: StatusResult): FlattenedStatus {
  const bc = result.broadcast;
  const tx = result.transactional;
  const merged = mergeProviders(pickScoped(bc?.campaign), pickScoped(tx?.campaign));
  if (bc?.brand?.contacted || tx?.brand?.contacted) merged.contacted = true;
  return { ...merged, global: mergeGlobal(bc?.global, tx?.global) };
}

/**
 * Collapse one provider's per-campaign breakdown down to the members of ONE campaign identity.
 *
 * email-gateway keys its evidence on the campaign id that sent the email, so a person served under
 * a stopped ancestor of the identity has no evidence under the LIVE campaign id — asking in
 * campaign mode for that one id answers "never contacted" for a person the customer paid to
 * contact. Brand mode returns `byCampaign`, so the identity's own members are read from it and
 * nothing outside the identity is counted (a brand-scope answer would over-report a brand running
 * several identities). Booleans OR, `sentCount` sums (disjoint campaigns), `first*At` take the
 * earliest, `lastDeliveredAt` the latest, and the reply classification comes from the member that
 * replied most recently.
 */
export function aggregateFamilyScope(
  provider: ProviderStatus | undefined,
  family: Set<string>,
): ScopedStatus | null {
  const byCampaign = provider?.byCampaign;
  if (!byCampaign) return null;

  const scopes = Object.entries(byCampaign)
    .filter(([campaignId]) => family.has(campaignId))
    .map(([, scope]) => scope)
    .filter((scope): scope is ScopedStatus => !!scope);
  if (scopes.length === 0) return null;

  const latestIso = (a: string | null, b: string | null): string | null => {
    if (!a) return b;
    if (!b) return a;
    return a >= b ? a : b;
  };

  let repliedAt: string | null = null;
  let replyClassification: ScopedStatus["replyClassification"] = null;
  for (const scope of scopes) {
    if (!scope.replyClassification) continue;
    if (repliedAt === null || (scope.firstRepliedAt ?? "") >= repliedAt) {
      repliedAt = scope.firstRepliedAt ?? "";
      replyClassification = scope.replyClassification;
    }
  }

  return scopes.reduce<ScopedStatus>(
    (acc, s) => ({
      contacted: acc.contacted || s.contacted,
      sent: acc.sent || s.sent,
      delivered: acc.delivered || s.delivered,
      opened: acc.opened || s.opened,
      clicked: acc.clicked || s.clicked,
      replied: acc.replied || s.replied,
      replyClassification,
      disqualified: mergeDisqualified(acc.disqualified, s.disqualified),
      bounced: acc.bounced || s.bounced,
      unsubscribed: acc.unsubscribed || s.unsubscribed,
      sentCount: (acc.sentCount ?? 0) + (s.sentCount ?? 0),
      lastDeliveredAt: latestIso(acc.lastDeliveredAt, s.lastDeliveredAt),
      firstContactedAt: earliestIso(acc.firstContactedAt, s.firstContactedAt),
      firstSentAt: earliestIso(acc.firstSentAt, s.firstSentAt),
      firstDeliveredAt: earliestIso(acc.firstDeliveredAt, s.firstDeliveredAt),
      firstOpenedAt: earliestIso(acc.firstOpenedAt, s.firstOpenedAt),
      firstClickedAt: earliestIso(acc.firstClickedAt, s.firstClickedAt),
      firstRepliedAt: earliestIso(acc.firstRepliedAt, s.firstRepliedAt),
      firstBouncedAt: earliestIso(acc.firstBouncedAt, s.firstBouncedAt),
      firstUnsubscribedAt: earliestIso(acc.firstUnsubscribedAt, s.firstUnsubscribedAt),
    }),
    {
      contacted: false, sent: false, delivered: false, opened: false, clicked: false,
      replied: false, replyClassification, bounced: false, unsubscribed: false, sentCount: 0,
      lastDeliveredAt: null, firstContactedAt: null, firstSentAt: null, firstDeliveredAt: null,
      firstOpenedAt: null, firstClickedAt: null, firstRepliedAt: null, firstBouncedAt: null,
      firstUnsubscribedAt: null,
    },
  );
}

/** The campaign-scope flatten for a campaign identity that spans several stored campaign rows. */
export function flattenFamilyStatus(result: StatusResult, family: Set<string>): FlattenedStatus {
  const bc = result.broadcast;
  const tx = result.transactional;
  const merged = mergeProviders(
    pickScoped(aggregateFamilyScope(bc, family)),
    pickScoped(aggregateFamilyScope(tx, family)),
  );
  // Same widening the single-campaign flatten applies: a person contacted anywhere for the brand
  // reads as contacted, so the campaign page never claims an untouched person we did reach.
  if (bc?.brand?.contacted || tx?.brand?.contacted) merged.contacted = true;
  return { ...merged, global: mergeGlobal(bc?.global, tx?.global) };
}

export function flattenBrandStatus(result: StatusResult): FlattenedStatus {
  const bc = result.broadcast;
  const tx = result.transactional;
  const merged = mergeProviders(pickScoped(bc?.brand), pickScoped(tx?.brand));
  return { ...merged, global: mergeGlobal(bc?.global, tx?.global) };
}

export const DEFAULT_STATUS: FlattenedStatus = {
  contacted: false, sent: false, delivered: false, opened: false, clicked: false,
  bounced: false, unsubscribed: false, replied: false, replyClassification: null, sentCount: 0, lastDeliveredAt: null,
  firstContactedAt: null, firstSentAt: null, firstDeliveredAt: null, firstOpenedAt: null,
  firstClickedAt: null, firstRepliedAt: null, firstBouncedAt: null, firstUnsubscribedAt: null,
  global: { bounced: false, unsubscribed: false },
};

/**
 * The evidence for ONE campaign identity, or null when the provider reports none for it.
 *
 * Null is the whole point of this function. A brand-scoped read stamps the brand's roll-up on
 * every row, so a person in eleven campaigns of one brand reads as contacted, clicked and replied
 * under all eleven — a claim about a campaign that may have sent them nothing. Asking the
 * breakdown for a campaign it holds no entry for answers "we cannot tell", NOT an all-false
 * status, because the two are different facts: the provider may simply not key its events by
 * campaign for that sender. An all-false default would print "no" where nobody looked.
 *
 * Deliberately WITHOUT the brand-contacted widening `flattenCampaignStatus` and
 * `flattenFamilyStatus` apply: that widening exists so a campaign page never claims we failed to
 * reach a person the brand did reach, and re-applying it here would restamp brand-wide evidence
 * onto every nested card, which is exactly the bug this answers.
 */
export function flattenCampaignSubsetStatus(
  result: StatusResult,
  campaignIds: Set<string>,
): FlattenedStatus | null {
  const bc = aggregateFamilyScope(result.broadcast, campaignIds);
  const tx = aggregateFamilyScope(result.transactional, campaignIds);
  if (!bc && !tx) return null;
  return {
    ...mergeProviders(pickScoped(bc), pickScoped(tx)),
    global: mergeGlobal(result.broadcast?.global, result.transactional?.global),
  };
}

/**
 * Fold a message the campaign's NON-EMAIL sender stated it sent (`leads_campaigns.channel_sent_at`, written by the
 * paid-pool retry off crm-service's send record, WA-RESERVE-LOOP-1014) into a served row's overlay: the person was
 * contacted and a message went out. email-gateway never sees a WhatsApp send, so without this a WhatsApp campaign
 * reads 0 contacted wherever the overlay is read (bucket counts, people.sent, standing, rows, activity).
 *
 * Applied ONLY to a served row in a named scope (the caller's existing rule): an unserved/unscoped row keeps the
 * all-false overlay. Email evidence is never overwritten: flags only turn on, timestamps take the earliest.
 */
export function withChannelSend(delivery: FlattenedStatus, channelSentAt: string | null | undefined): FlattenedStatus {
  if (!channelSentAt) return delivery;
  return {
    ...delivery,
    contacted: true,
    sent: true,
    sentCount: Math.max(delivery.sentCount, 1),
    firstContactedAt: earliestIso(delivery.firstContactedAt, channelSentAt),
    firstSentAt: earliestIso(delivery.firstSentAt, channelSentAt),
  };
}
