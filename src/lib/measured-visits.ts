/**
 * A website visit the DELIVERY LAYER already measured.
 *
 * A visit is measured automatically as a CLICK on the email we sent: email-gateway owns that
 * evidence, and nothing here changes what it measures or how a click is attributed. A human can
 * now state a visit too (`website_visit`, `src/lib/step-statements.ts`), because the automatic
 * signal misses — but the two describe the SAME step, so a lead carrying both must be counted
 * once, not twice.
 *
 * The join is only possible here: lead-service is what knows lead → brand → registered email, and
 * it is what asks email-gateway for delivery evidence everywhere else. So the guarantee is applied
 * where the two facts meet — a hand-stated visit is SUPPRESSED from the outcome reads when the
 * delivery layer already measured a click for that lead's registered email at brand scope. What a
 * consumer reads for `website_visit` is therefore the visits known ONLY by hand: the number it can
 * ADD to the measured click count without double-counting anybody.
 *
 * A lead with no registered email is never suppressed — the measured signal keys on the email, so
 * such a lead cannot be in the measured set at all and counting it cannot double-count.
 *
 * email-gateway unreachable is FAIL-LOUD (the caller answers 502): a guess in either direction is
 * a wrong number nothing would ever go red about.
 */
import { errorMessage } from "./db-error.js";
import { checkDeliveryStatus } from "./email-gateway-client.js";

export class MeasuredVisitLookupError extends Error {
  constructor(cause: unknown) {
    super(
      `[measured-visits] email-gateway could not answer whether these visits were already ` +
        `measured: ${errorMessage(cause)}`,
    );
    this.name = "MeasuredVisitLookupError";
  }
}

/** Whichever provider saw the click. Brand scope, because the count reads are brand-scoped. */
function clickedAtBrandScope(result: {
  broadcast?: { brand?: { clicked: boolean } | null } | null;
  transactional?: { brand?: { clicked: boolean } | null } | null;
}): boolean {
  return (
    result.broadcast?.brand?.clicked === true || result.transactional?.brand?.clicked === true
  );
}

/**
 * The subset of `emails` whose click the delivery layer has already measured for this brand,
 * lowercased. Empty input ⟹ no network call and an empty set.
 */
export async function fetchMeasuredVisitEmails(
  brandId: string,
  orgId: string,
  emails: string[],
): Promise<Set<string>> {
  const unique = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.length > 0))];
  if (unique.length === 0) return new Set();

  let response;
  try {
    response = await checkDeliveryStatus(
      brandId,
      undefined,
      unique.map((email) => ({ email })),
      { orgId, brandId },
    );
  } catch (error) {
    throw new MeasuredVisitLookupError(error);
  }

  const measured = new Set<string>();
  for (const result of response.results) {
    if (clickedAtBrandScope(result)) measured.add(result.email.trim().toLowerCase());
  }
  return measured;
}
