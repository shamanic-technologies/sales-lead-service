/**
 * ONE LEG, TWO SPELLINGS — the outbound leg-key rename, wave 1 (owner, 2026-10-09).
 *
 * "Lead found" is an ordinary funnel step: a sourcing campaign is Start -> Lead found, and an
 * OUTBOUND campaign takes the lead from there. So, for the outbound channels and ONLY those, the
 * fleet renames two leg keys (LOCKED, one identity shared by six codebases):
 *
 *     start_to_conversation   ->  lead_found_to_conversation
 *     start_to_website_visit  ->  lead_found_to_website_visit
 *
 * The same legacy keys on a NON-outbound channel (ads, SEO, PR...) are NOT renamed; sourcing keeps
 * `start_to_lead_found`; every other leg key is unchanged.
 *
 * Wave 1 (this module): wherever lead-service matches or dedups on a leg key, the two spellings of
 * an outbound leg are the SAME identity, while it keeps storing and serving exactly what it does
 * today. Wave 2 (separate brief) migrates the stored rows to the new spelling; nothing here changes
 * then, because every comparison already accepts both. Same rule and slug list as campaign-service
 * `src/lib/leg-identity.ts` (#575), billing-service #683, brand-service #630, features-service #1449
 * (`/public/channels` `legKeyCorrespondence[]`).
 */

/** The outbound channels (features-service channelType OUTBOUND), LOCKED by the rename brief. */
export const OUTBOUND_RENAMED_FEATURE_SLUGS: ReadonlySet<string> = new Set([
  "sales-cold-email-outreach",
  "feedback-request-cold-email-outreach",
  "sales-crm-email-outreach",
  "cold-call-outreach",
  "cold-instagram-outreach",
  "cold-linkedin-outreach",
  "cold-reddit-outreach",
  "cold-sms-outreach",
  "cold-whatsapp-outreach",
  "cold-x-outreach",
]);

/** new spelling -> legacy spelling, outbound channels only (LOCKED). */
const NEW_TO_LEGACY: ReadonlyMap<string, string> = new Map([
  ["lead_found_to_conversation", "start_to_conversation"],
  ["lead_found_to_website_visit", "start_to_website_visit"],
]);

/**
 * The value two spellings of one leg share, for COMPARISON only (never stored, never served): the
 * legacy spelling, so a legacy key comes back byte-identical. A non-outbound channel, a key outside
 * the rename, or a missing key comes back unchanged.
 */
export function legIdentity(featureSlug: string | null | undefined, legKey: string): string;
export function legIdentity(
  featureSlug: string | null | undefined,
  legKey: string | null | undefined,
): string | null | undefined;
export function legIdentity(
  featureSlug: string | null | undefined,
  legKey: string | null | undefined,
): string | null | undefined {
  if (!legKey || !featureSlug || !OUTBOUND_RENAMED_FEATURE_SLUGS.has(featureSlug)) return legKey;
  return NEW_TO_LEGACY.get(legKey) ?? legKey;
}
