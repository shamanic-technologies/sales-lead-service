/**
 * WHO ASKED, carried to code that has no `req` in hand — today only the legacy outbound leg-key
 * log (`leg-identity.ts`), which fires deep inside a campaign-service client.
 *
 * Node's own AsyncLocalStorage (no dependency): the middleware opens one store per inbound request
 * and every await under it sees the same store. Work outside a request (sweeps, boot) has none and
 * reads `undefined`; never invent a route for it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

export interface RequestContext {
  /** `METHOD /path` as received, query string dropped. */
  route: string;
  /** The calling service when it names itself (`x-caller-service`), else null. */
  caller: string | null;
  orgId: string | null;
  /** Lines already written for this request, so one arrival writes one line, not one per row. */
  logged: Set<string>;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

function header(req: Request, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function withRequestContext(req: Request, _res: Response, next: NextFunction): void {
  storage.run(
    {
      route: `${req.method} ${req.path}`,
      caller: header(req, "x-caller-service"),
      orgId: header(req, "x-org-id"),
      logged: new Set(),
    },
    next,
  );
}
