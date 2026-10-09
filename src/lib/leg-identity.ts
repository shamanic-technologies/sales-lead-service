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
 * Wave 1: wherever lead-service matches or dedups on a leg key, the two spellings of an outbound
 * leg are the SAME identity (`legIdentity`). Wave 2: every leg key lead-service SERVES is the new
 * spelling (`servedLegKey`), whichever one campaign-service stored; lead-service itself stores no
 * leg key (no column, no row carries one). The legacy spelling is still ACCEPTED everywhere. Same rule and slug list as campaign-service
 * `src/lib/leg-identity.ts` (#575), billing-service #683, brand-service #630, features-service #1449
 * (`/public/channels` `legKeyCorrespondence[]`).
 *
 * SWITCH-OFF IS MEASURED, not dated (owner 2026-10-09): every legacy outbound key that reaches this
 * service writes one `legacy-outbound-leg-key` warn line (`noteLegacyOutboundLegKey`). No route takes
 * a leg key from its caller; the keys arrive in campaign-service's answers, so the note sits where
 * those answers are read. Seven days with zero such lines in the container log = the tolerance below
 * can go.
 */
import { currentRequestContext } from "./request-context.js";

/** The literal the switch-off greps the container log for. */
export const LEGACY_OUTBOUND_LEG_KEY_MARKER = "legacy-outbound-leg-key";

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

const LEGACY_TO_NEW: ReadonlyMap<string, string> = new Map(
  [...NEW_TO_LEGACY].map(([renamed, legacy]) => [legacy, renamed]),
);

/**
 * The spelling lead-service SERVES for a leg key it read (wave 2): an outbound channel's legacy key
 * comes out in the new spelling; a non-outbound channel, a key outside the rename, or a missing
 * key comes back unchanged.
 */
export function servedLegKey(featureSlug: string | null | undefined, legKey: string): string;
export function servedLegKey(
  featureSlug: string | null | undefined,
  legKey: string | null | undefined,
): string | null | undefined;
export function servedLegKey(
  featureSlug: string | null | undefined,
  legKey: string | null | undefined,
): string | null | undefined {
  if (!legKey || !featureSlug || !OUTBOUND_RENAMED_FEATURE_SLUGS.has(featureSlug)) return legKey;
  return LEGACY_TO_NEW.get(legKey) ?? legKey;
}

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

/**
 * Write ONE warn line when `legKey` is the LEGACY spelling of an outbound leg; nothing otherwise.
 * `source` names who handed the key over. Inside a request the line carries the route and who
 * called, and repeats of the same (source, channel, key) in that request are not re-written;
 * outside one (a sweep) the route reads `background`. Returns nothing and never throws: the key is
 * still accepted exactly as before.
 */
export function noteLegacyOutboundLegKey(
  featureSlug: string | null | undefined,
  legKey: string | null | undefined,
  source: string,
): void {
  if (!legKey || !featureSlug || !OUTBOUND_RENAMED_FEATURE_SLUGS.has(featureSlug)) return;
  if (!LEGACY_TO_NEW.has(legKey)) return;
  const ctx = currentRequestContext();
  if (ctx) {
    const seen = `${source}|${featureSlug}|${legKey}`;
    if (ctx.logged.has(seen)) return;
    ctx.logged.add(seen);
  }
  console.warn(
    `[${LEGACY_OUTBOUND_LEG_KEY_MARKER}] key=${legKey} featureSlug=${featureSlug} source=${source} ` +
      `route=${ctx ? ctx.route : "background"} caller=${ctx?.caller ?? "-"} org=${ctx?.orgId ?? "-"}`,
  );
}
