/**
 * The org's own TEAM: who is a member of the org owning a brand (TEAM-OUT-OF-UNIBOX-1017, owner 2026-10-17: "Tu peux
 * aussi arrêter de m'afficher dans mon unibox, je suis un team member"). A team member is on the brand's side, the one
 * who writes: never a lead of the org's brands, never a row of its Unibox, never owed a follow-up. "team" wins over
 * every other tag (a member who paid on the product while testing is still no customer).
 *
 * Membership is client-service's fact (`GET /internal/users?orgId=&allMembers=true`: the users whose last active org it
 * is PLUS every member the identity provider holds). The widened `allMembers` read is opt-in at client-service because
 * other callers read the default list as "the customer's people" (2026-10-13 incident, client-service v0.27.17); it is
 * used HERE only to EXCLUDE, never as a predicate that grants anything. A staff member of a client org is a member of
 * it, so staff leave that client's Unibox too (accepted by the owner).
 *
 * One person, several addresses: a plus-tagged variant of a member's address (`local+tag@domain`, same local part and
 * domain, case-folded) is the member. Nothing else is folded (`kevin.lourdes@` is not `kevin.lourd@`).
 *
 * FAIL LOUD: client-service unreadable throws `OrgMembersUnavailableError`; every reader fails its pass (rows kept,
 * nothing filed), never "nobody is a member". Generic: no per-org or per-address list anywhere.
 */
import { errorMessage } from "./db-error.js";
import { CLIENT_SERVICE_API_KEY, CLIENT_SERVICE_URL } from "../config.js";
import { fetchWithRetry } from "./fetch-retry.js";

const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 500;
/** Members change rarely; one read per org per window on each thread. */
export const ORG_MEMBERS_TTL_MS = 5 * 60_000;

export class OrgMembersUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgMembersUnavailableError";
  }
}

/** The key one person's address folds to: lower-cased, `+tag` dropped from the local part. null = not an address. */
export function memberAddressKey(email: string | null | undefined): string | null {
  if (typeof email !== "string") return null;
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  const plus = local.indexOf("+");
  const base = plus === -1 ? local : local.slice(0, plus);
  if (base.length === 0) return null;
  return `${base}@${domain}`;
}

/** Is this address one of the members' (or a +tag variant of one)? */
export function isMemberAddress(email: string | null | undefined, members: ReadonlySet<string>): boolean {
  const key = memberAddressKey(email);
  return key !== null && members.has(key);
}

/** Does any of these addresses belong to a member? */
export function anyMemberAddress(emails: readonly (string | null | undefined)[] | null | undefined, members: ReadonlySet<string>): boolean {
  if (members.size === 0 || !emails) return false;
  return emails.some((e) => isMemberAddress(e, members));
}

interface UsersPage {
  users: Array<{ email: string | null }>;
  total: number;
}

async function fetchMemberEmails(orgId: string): Promise<string[]> {
  const emails: string[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const url =
      `${CLIENT_SERVICE_URL}/internal/users?orgId=${encodeURIComponent(orgId)}&allMembers=true` + `&limit=${PAGE_SIZE}&offset=${offset}`;
    let response: Response;
    try {
      response = await fetchWithRetry(url, { headers: { "x-api-key": CLIENT_SERVICE_API_KEY }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new OrgMembersUnavailableError(`client-service unreachable reading the members of org ${orgId}: ${errorMessage(error)}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OrgMembersUnavailableError(`client-service answered ${response.status} reading the members of org ${orgId}: ${body.slice(0, 300)}`);
    }
    const page = (await response.json()) as UsersPage;
    if (!Array.isArray(page?.users) || typeof page.total !== "number") {
      throw new OrgMembersUnavailableError(`client-service answered an unreadable member list for org ${orgId}`);
    }
    for (const u of page.users) if (u.email) emails.push(u.email);
    if (page.users.length < PAGE_SIZE || offset + page.users.length >= page.total) return emails;
  }
}

const cache = new Map<string, { keys: Set<string>; at: number }>();

/** Every member address key of the org (cached `ORG_MEMBERS_TTL_MS` per thread). Throws when unreadable. */
export async function loadOrgMemberKeys(orgId: string): Promise<Set<string>> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < ORG_MEMBERS_TTL_MS) return hit.keys;
  const keys = new Set<string>();
  for (const e of await fetchMemberEmails(orgId)) {
    const k = memberAddressKey(e);
    if (k) keys.add(k);
  }
  cache.set(orgId, { keys, at: Date.now() });
  return keys;
}

/** Test seam: forget every cached member list. */
export function clearOrgMembersCache(): void {
  cache.clear();
}
