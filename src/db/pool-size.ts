/**
 * The pool ceiling, parsed apart from the connection module (`index.ts` re-exports it) so a reader of the number
 * (`cursor-slots.ts`) never depends on how a test fakes the database module.
 */
export function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`[lead-service] ${name} must be a positive number, got '${raw}'`);
  }
  return Math.floor(parsed);
}

/** How many database connections this service may hold (see `index.ts`). */
export const POOL_MAX = positiveInt("LEAD_DB_POOL_MAX", 20);
