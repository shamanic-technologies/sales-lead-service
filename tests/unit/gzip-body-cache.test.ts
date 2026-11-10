import { beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { ResponseWriter } from "../../src/lib/stream-writer.js";
import { acceptsGzip, clearGzipBodyCache, recordingGzip, replayGzipBody } from "../../src/lib/gzip-body-cache.js";

let builds = 0;
let release: () => void = () => undefined;
let gate: Promise<void> = Promise.resolve();

function appFor(body: () => string) {
  const app = express();
  app.get("/x", async (req, res) => {
    const key = `k:${req.query.v}`;
    if (acceptsGzip(req) && (await replayGzipBody(key, res))) return;
    builds += 1;
    const out = new ResponseWriter(acceptsGzip(req) ? recordingGzip(key, res) : res);
    await out.write("[");
    await gate;
    await out.write(body());
    await out.write("]");
    await out.end();
  });
  return app;
}

describe("gzip body cache", () => {
  beforeEach(() => {
    clearGzipBodyCache();
    builds = 0;
    gate = Promise.resolve();
  });

  it("replays the same bytes for the same key, builds again for another key", async () => {
    let n = 0;
    const app = appFor(() => `"${++n}"`);
    const a = await request(app).get("/x?v=1");
    const b = await request(app).get("/x?v=1");
    expect(a.headers["content-encoding"]).toBe("gzip");
    expect(b.text).toBe(a.text);
    expect(builds).toBe(1);
    const c = await request(app).get("/x?v=2");
    expect(c.text).not.toBe(a.text);
    expect(builds).toBe(2);
  });

  it("builds a body ONCE for readers arriving together, every one getting the same bytes", async () => {
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = appFor(() => '"same"');
    const pending = Array.from({ length: 5 }, () => request(app).get("/x?v=3"));
    setTimeout(() => release(), 50);
    const answers = await Promise.all(pending);
    expect(new Set(answers.map((r) => r.text))).toEqual(new Set(['["same"]']));
    expect(builds).toBe(1);
  });

  it("serves an identity body to a caller refusing gzip, and keeps nothing for it", async () => {
    const app = appFor(() => '"plain"');
    const a = await request(app).get("/x?v=4").set("Accept-Encoding", "identity");
    expect(a.headers["content-encoding"]).toBeUndefined();
    expect(a.text).toBe('["plain"]');
    await request(app).get("/x?v=4").set("Accept-Encoding", "identity");
    expect(builds).toBe(2);
  });
});
