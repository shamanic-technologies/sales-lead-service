import type { BrandMembership } from "./audience-client.js";
import type { SourcingOriginName } from "./sourcing-origin.js";

/**
 * EVERY SOURCE THAT FOUND A PERSON, for the lead's brand (owner 2026-10-08: "It must be tagged both
 * ... So we know a human belongs to several signals, which is a higher interest").
 *
 * human-service records each audience of the brand that found the person, with how: `served` (a serve
 * under that audience handed the person out) or `found_taken` (that audience's search found them while
 * they were already taken for the brand). The audience's LIST KIND is the sourcing origin, and
 * features-service names it for a customer ("Apollo Cold Filters", "LinkedIn Engagement Signals").
 * Nothing here is guessed from an audience name or a cost name: no list kind, or a list kind the
 * catalogue does not name, is served with `origin: null` rather than a made-up label.
 *
 * Additive beside `audience` (the serving audience's card, unchanged): this does not move which audience
 * a lead is attributed to.
 */

export interface LeadSource {
  audienceId: string;
  offerId: string | null;
  /** human-service's audience list kind; null when the audience states none. */
  list: string | null;
  /** The customer-facing origin of that list kind; null when the catalogue names none. */
  origin: SourcingOriginName | null;
  /** True for the source whose serve handed this person out (provenance `served`). */
  servedLead: boolean;
}

/**
 * The person's sources, the serving one first, then by origin name, then audience id (stable order so
 * the same person renders the same tags on every read).
 */
export function toLeadSources(
  memberships: BrandMembership[],
  originsByList: Map<string, SourcingOriginName>,
): LeadSource[] {
  return memberships
    .map((m) => ({
      audienceId: m.audienceId,
      offerId: m.offerId,
      list: m.list,
      origin: m.list ? originsByList.get(m.list) ?? null : null,
      servedLead: m.provenance === "served",
    }))
    .sort((a, b) => {
      if (a.servedLead !== b.servedLead) return a.servedLead ? -1 : 1;
      const an = a.origin?.name ?? "￿";
      const bn = b.origin?.name ?? "￿";
      if (an !== bn) return an < bn ? -1 : 1;
      return a.audienceId < b.audienceId ? -1 : a.audienceId > b.audienceId ? 1 : 0;
    });
}
