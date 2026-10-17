/**
 * The members each org has in a test (tests/setup.ts mocks org-members.ts `loadOrgMemberKeys` onto this). Held on
 * globalThis so a `vi.resetModules()` in a test never splits the map the mock reads from the one the test writes.
 */
const KEY = "__leadServiceTestOrgMembers";
const g = globalThis as unknown as Record<string, Map<string, string[]> | undefined>;
export const testOrgMembers: Map<string, string[]> = (g[KEY] ??= new Map<string, string[]>());

export function setTestOrgMembers(orgId: string, emails: string[]): void {
  testOrgMembers.set(orgId, emails);
}

export function clearTestOrgMembers(): void {
  testOrgMembers.clear();
}
