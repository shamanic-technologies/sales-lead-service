import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { loadOutreachFeedState } from "./outreach-fact-feed.js";
import { emailedWithin, type RecentlyEmailedScope } from "./recently-emailed-sql.js";

// IO half of tactic "Fresh contacts only" (FRESH-CONTACTS-1015); the rule and its SQL live in recently-emailed-sql.ts
// (pure: src/schemas.ts reads its window list and must never reach the database at import).

/** Was this lead emailed by the brand inside the window? (A person a fresh serve just bought.) */
export async function leadRecentlyEmailed(leadId: string, scope: RecentlyEmailedScope): Promise<boolean> {
  if (scope.brandIds.length === 0) return false;
  const rows = (await db.execute(sql`SELECT ${emailedWithin(sql`${leadId}::uuid`, scope)} AS hit`)) as unknown as Array<{ hit: boolean }>;
  return rows[0]?.hit === true;
}

/** A copy that never reached the feed's end cannot say who was emailed: the serve fails rather than hand anyone out. */
export class RecentlyEmailedUnknownError extends Error {
  constructor() {
    super("[lead-service] excludeEmailedWithin: the copy of instantly-service's outreach facts has not caught up yet");
    this.name = "RecentlyEmailedUnknownError";
  }
}

export async function assertRecentlyEmailedReadable(): Promise<void> {
  const state = await loadOutreachFeedState();
  if (!state.caughtUp) throw new RecentlyEmailedUnknownError();
}
