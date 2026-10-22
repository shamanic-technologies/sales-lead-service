import { errorMessage } from "./db-error.js";
/**
 * Boot readiness state.
 *
 * The port opens BEFORE migrations run (see `src/index.ts`), so Railway's 30s
 * healthcheck window is never spent waiting on a Neon compute that is resuming
 * from scale-to-zero (a cold resume costs ~1-7s, and the first connection can
 * abort outright). Opening the port first decouples "the container is up" from
 * "the database answered".
 *
 * That trade is only safe if traffic is GATED until migrations finish: the
 * service must never serve a request against a schema its code does not expect.
 * So this module carries the three-way boot state that both `/health` and the
 * readiness middleware read:
 *
 *   starting — port open, migrations still running. `/health` 200 (Railway sees
 *              a live container), every other route 503. Nothing touches the DB.
 *   ready    — migrations applied, providers registered. Normal serving.
 *   failed   — migrations could not be applied. `/health` 503 + every route 503,
 *              so the deploy fails its healthcheck LOUDLY and Railway keeps the
 *              previous release. The process stays alive on purpose: exiting
 *              produces a restart loop that shreds the logs carrying the reason.
 */

export type BootState = "starting" | "ready" | "failed";

let state: BootState = "starting";
let failureMessage: string | null = null;

export function getBootState(): BootState {
  return state;
}

export function getBootFailure(): string | null {
  return failureMessage;
}

export function markBootReady(): void {
  state = "ready";
  failureMessage = null;
}

export function markBootFailed(err: unknown): void {
  state = "failed";
  failureMessage = errorMessage(err);
}

/** Test-only: restore the initial state between cases. */
export function resetBootState(): void {
  state = "starting";
  failureMessage = null;
}
