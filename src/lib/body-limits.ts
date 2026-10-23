import express from "express";
import type { NextFunction, Request, Response } from "express";

/**
 * JSON body limits (LEAD-ID-RESOLVE-413-1024). The global parser keeps express's 100kb default; a route whose
 * DOCUMENTED batch maximum can exceed it gets its own parser, mounted BEFORE the global one (src/app.ts), sized
 * so the documented maximum always fits. A body over a route's limit is a NAMED 413, never a bare 500.
 *
 * - /internal/leads/ids/resolve: 1000 items (orgId, up to 50 brandIds, five identity keys) ~ 0.2-1 KB each.
 * - /orgs/leads/evidence-changed: 1000 addresses of up to 320 chars ~ 330 KB.
 * - /internal/reply-latency: 100 groups x 500 campaign ids ~ 2 MB.
 */
export const DEFAULT_JSON_LIMIT = "100kb";

export const ROUTE_JSON_LIMITS: ReadonlyArray<{ path: string; limit: string }> = [
  { path: "/internal/leads/ids/resolve", limit: "10mb" },
  { path: "/orgs/leads/evidence-changed", limit: "1mb" },
  { path: "/internal/reply-latency", limit: "4mb" },
];

export function mountJsonParsers(app: express.Express): void {
  for (const { path, limit } of ROUTE_JSON_LIMITS) app.use(path, express.json({ limit }));
  app.use(express.json({ limit: DEFAULT_JSON_LIMIT }));
}

type BodyParserError = Error & { type?: string; limit?: number; length?: number; expose?: boolean };

/** Turns body-parser refusals into named 4xx answers; anything else goes on to the 500 handler. */
export function bodyParserErrorHandler(err: BodyParserError, req: Request, res: Response, next: NextFunction) {
  if (err?.type === "entity.too.large") {
    return res.status(413).json({
      error: "payload_too_large",
      message: `Request body is ${err.length ?? "?"} bytes; ${req.method} ${req.path} accepts at most ${err.limit ?? "?"} bytes. Send fewer items per call.`,
      limitBytes: err.limit ?? null,
      lengthBytes: err.length ?? null,
    });
  }
  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "invalid_json", message: "Request body is not valid JSON." });
  }
  if (err?.type === "encoding.unsupported" || err?.type === "charset.unsupported") {
    return res.status(415).json({ error: "unsupported_encoding", message: err.message });
  }
  return next(err);
}
