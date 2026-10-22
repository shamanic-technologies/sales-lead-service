/**
 * WHO a served person is (human-service) and WHERE they work (brand-service), asked on the serve
 * itself so the lead the serve lands on is the one for (human, company) (owner 2026-10-13,
 * LEAD-REFONTE-1013): a known human at a NEW company is a NEW lead with a clean slate.
 *
 * Both answers come from their owners; nothing is decided here. A serve is already PAID when this
 * runs (human-service billed it), so an owner that cannot answer must not strand it: the answer is
 * `null`, logged loudly, the serve lands on the lead today's email-first rule picks, and the identity
 * sweep (lead-identity-sweep.ts) resolves that lead's human and company minutes later.
 */
import { errorMessage } from "./db-error.js";
import type { Person } from "./people-client.js";
import { resolveHuman } from "./human-identity-client.js";
import { resolveCompanies } from "./company-client.js";
import { humanKeysOf, hasAnyKey } from "./lead-identity.js";

export interface ServedIdentity {
  humanId: string | null;
  /** brand-service brand id of the person's current employer; null = no safe company identity. */
  companyId: string | null;
}

const blank = (v: string | null | undefined): string | null => {
  const t = typeof v === "string" ? v.trim() : "";
  return t.length > 0 ? t : null;
};

export async function resolveServedIdentity(person: Person): Promise<ServedIdentity | null> {
  try {
    const keys = humanKeysOf({
      lead_id: "served",
      apollo_person_id: person.providerPersonId,
      provider: person.provider,
      linkedin_url: person.linkedinUrl,
      emails: person.email ? [person.email] : [],
      phones: typeof person.phone === "string" ? [person.phone] : [],
    });
    const org = person.organization;
    const [human, company] = await Promise.all([
      hasAnyKey(keys) ? resolveHuman({ ...keys, create: true }) : Promise.resolve(null),
      org
        ? resolveCompanies([
            {
              domain: blank(org.domain) ?? blank(org.websiteUrl),
              linkedinUrl: blank(org.linkedinUrl),
              apolloOrganizationId: blank(org.providerOrganizationId),
              name: blank(org.name),
            },
          ]).then((r) => r[0])
        : Promise.resolve(null),
    ]);
    return { humanId: human?.humanId ?? null, companyId: company?.brandId ?? null };
  } catch (err) {
    console.error(
      `[lead-service] serve identity unresolved (the identity sweep resolves it later): email=${person.email ?? ""} ` +
        `providerPersonId=${person.providerPersonId ?? ""}: ${errorMessage(err)}`,
    );
    return null;
  }
}
