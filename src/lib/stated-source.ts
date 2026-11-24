/**
 * WHERE A SERVE FINDS PEOPLE, STATED BY THE SCRIPT (SERVE-SOURCE-AS-DATA-1124, owner 2026-11-24: « add the instructions
 * in the brief, so the source chosen is filtered by what the user wants »).
 *
 * A Lead found script states, on `POST /orgs/buffer/next`, the source it finds people in (`findPeopleIn`), in plain
 * words a judge can read. Each value is ONE source of features-service's catalogue (its slug below), the same source a
 * run of that slug finds in today: same audiences (`resolveSourceAudiences`: own list of that origin, or an ON source of
 * a list kind it counts; Lead Sourcing = the origins human-service chose for the brand), same label on the serve run
 * and every call under it (sourcing origin, billing), same purchases. Never a default: a stated source that cannot serve
 * answers a named reason; absent = today's serve, bytes unchanged.
 */
export const FIND_PEOPLE_IN = [
  "sources_picked_for_the_brand",
  "apollo_cold_filters",
  "apollo_buying_signals",
  "linkedin_post_engagement",
  "client_crm_contacts",
] as const;

export type FindPeopleIn = (typeof FIND_PEOPLE_IN)[number];

/** The catalogue source each value names (features-service `/public/sourcing-origins` slugs + Lead Sourcing). */
export const SOURCE_SLUG_OF: Record<FindPeopleIn, string> = {
  sources_picked_for_the_brand: "lead-sourcing",
  apollo_cold_filters: "sourcing-apollo-cold-filters",
  apollo_buying_signals: "sourcing-apollo-buying-signals",
  linkedin_post_engagement: "sourcing-linkedin-engagement-signals",
  client_crm_contacts: "sourcing-crm-contacts",
};

export interface StatedSource {
  findPeopleIn: FindPeopleIn;
  slug: string;
}

export function statedSourceOf(value: FindPeopleIn | null | undefined): StatedSource | null {
  return value ? { findPeopleIn: value, slug: SOURCE_SLUG_OF[value] } : null;
}
