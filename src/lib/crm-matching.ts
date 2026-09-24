/**
 * Matching THEIR contacts to OUR leads, frozen — shared by the pairings view and the CRM evidence
 * sync, so a contact is paired the same way whichever of them reaches it first.
 *
 * A contact already matched is NEVER re-matched: that is what makes a second read of the view
 * return the same pairings.
 */
import { matchConversion, type MatchResult } from "./conversions.js";
import { freezeMatches, loadFrozenMatches, type FrozenMatch } from "./crm-pairing-store.js";
import type { CrmContact } from "./crm-client.js";

/** How many waterfalls run at once while walking their CRM. Each is a handful of indexed probes. */
const MATCH_CONCURRENCY = 8;

/** The matcher's input, built from THEIR contact. Nothing is invented — an absent field stays absent. */
function waterfallInputFor(brandId: string, contact: CrmContact) {
  return {
    brandId,
    email: contact.primaryEmail,
    phone: contact.phoneE164,
    firstName: contact.firstName,
    lastName: contact.lastName,
    // Their company reaches the domain tier only as a URL/domain. A company NAME is not a domain
    // and is never coerced into one — it goes to the judgment, which is where a name is useful.
    companyUrl: contact.companyUrl ?? null,
  };
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order in the output. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The frozen match for every contact on this page, matching (and freezing) whatever had none.
 *
 * A contact already matched is NEVER re-matched — that is what makes a second read of the view
 * return the same pairings.
 */
export async function matchesForContacts(
  orgId: string,
  brandId: string,
  contacts: CrmContact[],
): Promise<Map<string, FrozenMatch>> {
  const ids = contacts.map((c) => c.id);
  const frozen = await loadFrozenMatches(brandId, ids);
  const missing = contacts.filter((c) => !frozen.has(c.id));
  if (missing.length === 0) return frozen;

  const results = await mapWithConcurrency(
    missing,
    MATCH_CONCURRENCY,
    async (contact): Promise<{ crmContactId: string; result: MatchResult }> => ({
      crmContactId: contact.id,
      result: await matchConversion(waterfallInputFor(brandId, contact)),
    }),
  );
  const written = await freezeMatches(orgId, brandId, results);
  for (const [id, match] of written) frozen.set(id, match);
  return frozen;
}

