/**
 * What the request router says when a forwarded request does not complete.
 *
 * Two different things end a forwarded request early, and the log must not confuse them:
 *   - the THREAD did not answer (refused, crashed, timed out): an incident, logged as an error and
 *     answered 502;
 *   - the CALLER left first (navigated away, its own timeout): the router cancels the work on the
 *     thread, which surfaces as a "socket hang up" on the upstream request. That is not the thread's
 *     failure; logging it as "did not answer" made a healthy service read as a hanging one
 *     (2026-10-08: ~10 such lines an hour, every one a caller that left).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { forward } from "../../src/thread-forward.js";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
  vi.restoreAllMocks();
});

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

async function routerTo(threadPort: number): Promise<number> {
  const router = express();
  router.use((req, res) => forward(req, res, { name: "interactive", port: threadPort }));
  return listen(http.createServer(router));
}

describe("forwarding a request to an HTTP thread", () => {
  it("relays the thread's answer untouched", async () => {
    const threadPort = await listen(http.createServer((_req, res) => res.writeHead(201, { "x-a": "1" }).end("ok")));
    const port = await routerTo(threadPort);
    const res = await fetch(`http://127.0.0.1:${port}/orgs/leads/bucket-counts`);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-a")).toBe("1");
    expect(await res.text()).toBe("ok");
  });

  it("a thread that refuses the connection is an error and a 502 naming the thread", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const closed = http.createServer();
    const deadPort = await listen(closed);
    await new Promise((r) => closed.close(() => r(null)));
    servers.splice(servers.indexOf(closed), 1);
    const port = await routerTo(deadPort);
    const res = await fetch(`http://127.0.0.1:${port}/orgs/leads/bucket-counts`);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("interactive HTTP thread unavailable");
    expect(error.mock.calls.map((c) => String(c[0])).join("\n")).toContain("did not answer");
  });

  it("a caller who leaves is logged as the caller leaving, never as the thread not answering", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let threadSawClose!: () => void;
    const threadClosed = new Promise<void>((r) => (threadSawClose = r));
    const threadPort = await listen(
      http.createServer((req) => {
        req.socket.on("close", () => threadSawClose()); // never answers: a slow read
      }),
    );
    const port = await routerTo(threadPort);
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/orgs/leads/standing-counts?brandId=b`, {
      signal: controller.signal,
    }).catch((e: Error) => e.name);
    await new Promise((r) => setTimeout(r, 100));
    controller.abort();
    expect(await pending).toBe("AbortError");
    await threadClosed; // the work on the thread was cancelled
    await new Promise((r) => setTimeout(r, 20));
    const errors = error.mock.calls.map((c) => String(c[0])).join("\n");
    expect(errors).not.toContain("did not answer");
    const logs = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logs).toMatch(/caller left GET \/orgs\/leads\/standing-counts\?brandId=b after \d+ms/);
  });
});
