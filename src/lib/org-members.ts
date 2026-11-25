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

/** One member as client-service states them. */
export interface OrgUser {
  email: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
}

/** One PERSON of the org's team: every address that folds to the same `memberAddressKey` is theirs. */
export interface OrgMember {
  /** Their first address as stated (lower-cased), or null for a member known by phone alone. */
  email: string | null;
  /** Every address of theirs (lower-cased, the +tag variants included), in the order stated. */
  emails: string[];
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
}

interface UsersPage {
  users: OrgUser[];
  total: number;
}

async function fetchMembers(orgId: string): Promise<OrgUser[]> {
  const users: OrgUser[] = [];
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
    users.push(...page.users);
    if (page.users.length < PAGE_SIZE || offset + page.users.length >= page.total) return users;
  }
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * PURE. The org's members as PEOPLE: users whose addresses fold to the same key are one person (first name, last name
 * and phone = the first stated among them); a user with no address is kept only when a phone is stated.
 */
export function foldOrgMembers(users: readonly OrgUser[]): OrgMember[] {
  const byKey = new Map<string, OrgMember>();
  const out: OrgMember[] = [];
  for (const u of users) {
    const key = memberAddressKey(u.email);
    const email = key ? u.email!.trim().toLowerCase() : null;
    const phone = text(u.phone);
    if (!key) {
      if (phone) out.push({ email: null, emails: [], firstName: text(u.firstName), lastName: text(u.lastName), phone });
      continue;
    }
    const prior = byKey.get(key);
    if (!prior) {
      const member: OrgMember = { email, emails: [email!], firstName: text(u.firstName), lastName: text(u.lastName), phone };
      byKey.set(key, member);
      out.push(member);
      continue;
    }
    if (!prior.emails.includes(email!)) prior.emails.push(email!);
    prior.firstName = prior.firstName ?? text(u.firstName);
    prior.lastName = prior.lastName ?? text(u.lastName);
    prior.phone = prior.phone ?? phone;
  }
  return out;
}

const cache = new Map<string, { users: OrgUser[]; keys: Set<string>; at: number }>();

async function loadCached(orgId: string): Promise<{ users: OrgUser[]; keys: Set<string> }> {
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < ORG_MEMBERS_TTL_MS) return hit;
  const users = await fetchMembers(orgId);
  const keys = new Set<string>();
  for (const u of users) {
    const k = memberAddressKey(u.email);
    if (k) keys.add(k);
  }
  const entry = { users, keys, at: Date.now() };
  cache.set(orgId, entry);
  return entry;
}

/** Every member address key of the org (cached `ORG_MEMBERS_TTL_MS` per thread). Throws when unreadable. */
export async function loadOrgMemberKeys(orgId: string): Promise<Set<string>> {
  return (await loadCached(orgId)).keys;
}

/**
 * The org's members as people, with what client-service states of each (name, phone): the same read and cache as
 * `loadOrgMemberKeys` (TEAM-PAST-EMPLOYERS-1125). Throws `OrgMembersUnavailableError` when unreadable.
 */
export async function loadOrgMembers(orgId: string): Promise<OrgMember[]> {
  return foldOrgMembers((await loadCached(orgId)).users);
}

/** Test seam: forget every cached member list. */
export function clearOrgMembersCache(): void {
  cache.clear();
}
