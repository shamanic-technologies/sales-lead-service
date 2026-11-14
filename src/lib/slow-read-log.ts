/**
 * Every GET that takes over a second to answer is logged with its duration (MON-PAGE-SPEED-1114, owner: every
 * dashboard page under 1 s). The page-speed robot only sees the dashboard's side; this line says, from inside the
 * service, which read was slow and when, so a slow morning can be read back from the container log instead of guessed.
 * One line per slow read, nothing for a fast one; ids are kept (the path names the lead/brand being read, no address).
 */
import type { NextFunction, Request, Response } from "express";

export const SLOW_READ_MS = 1_000;

export function slowReadLog(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== "GET") {
    next();
    return;
  }
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
    if (ms >= SLOW_READ_MS) {
      console.warn(`[slow-read] GET ${req.originalUrl.split("?")[0]} status=${res.statusCode} ms=${ms} query=${slowReadQuery(req.originalUrl)}`);
    }
  });
  next();
}

/** The query's parameter NAMES and ids, never an email address (a `?email=` read names a person). */
export function slowReadQuery(url: string): string {
  const q = url.indexOf("?");
  if (q === -1) return "-";
  const params = new URLSearchParams(url.slice(q + 1));
  return [...params.entries()].map(([k, v]) => `${k}=${v.includes("@") ? "<address>" : v}`).join("&") || "-";
}
