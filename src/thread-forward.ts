/**
 * Handing a request to an HTTP thread (src/http-worker.ts) and its answer back, untouched.
 *
 * Two different things end a forwarded request early, and the log keeps them apart:
 *   - the THREAD did not answer (refused, crashed, timed out): an incident, logged as an error and
 *     answered 502 naming the thread;
 *   - the CALLER left first (navigated away, its own timeout): the work on the thread is cancelled,
 *     which surfaces on the upstream request as a "socket hang up". That is not the thread failing.
 *     Logged as "did not answer", it made a healthy service read as a hanging one (2026-10-08:
 *     ~10 lines an hour, every one a caller that had left), and would have hidden a real hang.
 */
import http from "node:http";
import type { Request, Response } from "express";

export interface ForwardTarget {
  name: string;
  port: number;
}

/** Connection-scoped headers: each hop sets its own. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

function forwardableRequestHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(key)) out[key] = value;
  }
  return out;
}

function forwardableResponseHeaders(raw: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (!HOP_BY_HOP.has(raw[i].toLowerCase())) out.push(raw[i], raw[i + 1]);
  }
  return out;
}

/** Hand the request to a thread and its answer back, untouched; a caller who leaves cancels it. */
export function forward(req: Request, res: Response, thread: ForwardTarget): void {
  const startedAt = Date.now();
  let callerLeft = false;
  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: thread.port,
      method: req.method,
      path: req.originalUrl,
      headers: forwardableRequestHeaders(req.headers),
      agent: upstreamAgent,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, forwardableResponseHeaders(upstreamRes.rawHeaders));
      upstreamRes.pipe(res);
      upstreamRes.on("error", (err) => res.destroy(err));
    },
  );
  upstream.on("error", (err) => {
    if (callerLeft) {
      console.log(
        `[lead-service] caller left ${req.method} ${req.originalUrl} after ${Date.now() - startedAt}ms; ` +
          `cancelled on the ${thread.name} HTTP thread`,
      );
      return;
    }
    if (res.headersSent) {
      res.destroy(err);
      return;
    }
    console.error(`[lead-service] ${thread.name} HTTP thread did not answer ${req.method} ${req.originalUrl}:`, err);
    res.status(502).json({ error: `lead-service ${thread.name} HTTP thread unavailable` });
  });
  // The caller left: stop the work it asked for (the thread's own client-abort checks see it).
  res.on("close", () => {
    if (res.writableFinished) return;
    callerLeft = true;
    upstream.destroy();
  });
  req.pipe(upstream);
}
