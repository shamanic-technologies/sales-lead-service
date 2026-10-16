/**
 * The address formats the services lead-service sends addresses to IN A BATCH accept, each stated
 * as its own validator states it (LEAD-CHANGES-INVALID-EMAIL-1016).
 *
 * One address a receiver refuses makes it refuse the WHOLE batch, so one malformed lead (two
 * customer.io unsubscribe addresses filed by the Unibox intake, `32.<base32>====@unsubscribe2.customer.io`)
 * took down every read of its scope: first email-gateway `/orgs/status` (v0.83.130), then
 * instantly-service `/orgs/reply-verdicts/query`. A batch client drops what its receiver would
 * refuse BEFORE asking (`keepAccepted`), names each dropped address loudly with its lead, and asks
 * about the rest. The receiver can never have acted on an address it refuses, so "nothing" is the
 * true answer for it.
 */
import { z } from "zod";

const zodEmail = z.string().email();

/** `z.string().email()` (zod 4): email-gateway (`/orgs/status`, send `to`) and instantly-service (`/orgs/reply-verdicts/query`). */
export function isZodEmail(email: string): boolean {
  return zodEmail.safeParse(email).success;
}

/** crm-service `normalizeEmail` (people/identity.ts): trimmed, lower-cased, `^[^\s@]+@[^\s@]+\.[^\s@]+$`. */
export function isCrmMatchableEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim().toLowerCase());
}

/**
 * The addresses `accepts` keeps, in order. Each one dropped is logged with `console.error`, naming
 * the receiver, the address and its lead (`leadOf`, keyed by the address as given or lower-cased).
 */
export function keepAccepted(
  emails: readonly string[],
  accepts: (email: string) => boolean,
  receiver: string,
  leadOf?: ReadonlyMap<string, string>,
): string[] {
  const kept: string[] = [];
  for (const email of emails) {
    if (accepts(email)) {
      kept.push(email);
      continue;
    }
    const leadId = leadOf?.get(email) ?? leadOf?.get(email.trim().toLowerCase()) ?? "unknown";
    console.error(
      `[lead-service] ${receiver}: address SKIPPED, malformed for the receiver ${JSON.stringify(email)} (lead ${leadId}): ` +
        `it would refuse the whole batch; it can never have acted on it, so it is answered with nothing`,
    );
  }
  return kept;
}
