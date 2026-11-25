/**
 * The members each org has in a test (tests/setup.ts mocks org-members.ts `loadOrgMemberKeys` and `loadOrgMembers` onto this). Held on
 * globalThis so a `vi.resetModules()` in a test never splits the map the mock reads from the one the test writes.
 */
const KEY = "__leadServiceTestOrgMembers";
/** A member as an address, or as client-service states them (name, phone). */
export type TestOrgMember = string | { email: string | null; firstName?: string | null; lastName?: string | null; phone?: string | null };
const g = globalThis as unknown as Record<string, Map<string, TestOrgMember[]> | undefined>;
export const testOrgMembers: Map<string, TestOrgMember[]> = (g[KEY] ??= new Map<string, TestOrgMember[]>());

export function setTestOrgMembers(orgId: string, members: TestOrgMember[]): void {
  testOrgMembers.set(orgId, members);
}

export function clearTestOrgMembers(): void {
  testOrgMembers.clear();
}
