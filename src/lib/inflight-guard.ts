/**
 * Per-(orgId, campaignId) in-flight guard for buffer/next.
 *
 * campaign-service is supposed to serialize workflow runs per campaign, so
 * lead-service should never see two concurrent buffer/next requests for the
 * same campaign. This guard fails loud (409) when that invariant breaks,
 * surfacing the upstream bug instead of letting it manifest as a deep DB
 * unique-constraint error inside the strategy persist path.
 *
 * In-process only — single replica today. If we scale lead-service to
 * multiple instances, swap this for a pg advisory lock.
 */

export interface InflightEntry {
  parentRunId: string;
  brandIds: string[];
  startedAt: number;
  workflowSlug?: string;
  featureSlug?: string;
}

const inflight = new Map<string, InflightEntry>();

export function inflightKey(orgId: string, campaignId: string): string {
  return `${orgId}:${campaignId}`;
}

export type AcquireResult =
  | { acquired: true }
  | { acquired: false; existing: InflightEntry };

export function tryAcquire(
  orgId: string,
  campaignId: string,
  entry: InflightEntry,
): AcquireResult {
  const key = inflightKey(orgId, campaignId);
  const existing = inflight.get(key);
  if (existing) return { acquired: false, existing };
  inflight.set(key, entry);
  return { acquired: true };
}

export function release(orgId: string, campaignId: string): void {
  inflight.delete(inflightKey(orgId, campaignId));
}

// Test-only: lets unit tests reset the module-level state between cases.
export function __resetInflight(): void {
  inflight.clear();
}
