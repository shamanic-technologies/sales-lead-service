/**
 * The GZIPPED bytes of a whole answer, kept so the same answer is not serialized and compressed
 * again while nothing it was read from moved (DASH-SPEED-1110-LEAD-R3).
 *
 * Why. A change feed's full snapshot and a plain compact walk served from a current feed are a
 * function of (feed, committed version, page): two reads at the same version write the same bytes.
 * On the largest brand that answer is 4.5 MB of JSON (13.5 MB on another), and ten readers at once
 * paid ten serializations and ten gzip passes on one thread (1.2-1.4 s each). A key names the feed's
 * committed version, so any write to the feed is a new key: a kept body is never served past a
 * change the feed holds.
 *
 * Bounded. Only a body whose compressed size stays under `MAX_ENTRY_BYTES` is kept, the cache as a
 * whole under `MAX_TOTAL_BYTES`, least recently used out first. In-process (per HTTP thread): a miss
 * is only the work every read did before. Memory held per answer = its compressed size (~10x below
 * the JSON), never the serialized population.
 */
import { createGzip, type Gzip } from "node:zlib";
import type { Request, Response } from "express";

const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;

interface Entry {
  chunks: Buffer[];
  bytes: number;
}

const entries = new Map<string, Entry>();
let totalBytes = 0;
/** Bodies being built right now: a read of the same key waits for it, then replays (never N builds at once). */
const building = new Map<string, Promise<void>>();
/** How long a read waits on another read's build before building its own. */
const BUILD_WAIT_MS = 30_000;

function remember(key: string, entry: Entry): void {
  if (entry.bytes > MAX_ENTRY_BYTES) return;
  const prior = entries.get(key);
  if (prior) {
    entries.delete(key);
    totalBytes -= prior.bytes;
  }
  entries.set(key, entry);
  totalBytes += entry.bytes;
  for (const [k, e] of entries) {
    if (totalBytes <= MAX_TOTAL_BYTES) break;
    entries.delete(k);
    totalBytes -= e.bytes;
  }
}

/** Test-only. */
export function clearGzipBodyCache(): void {
  entries.clear();
  building.clear();
  totalBytes = 0;
}

/** Whether the caller takes a gzip body (express's own negotiation, `q=0` honoured). */
export function acceptsGzip(req: Request): boolean {
  return req.acceptsEncodings("gzip", "identity") === "gzip";
}

function gzipHeaders(res: Response): void {
  res.setHeader("Content-Type", "application/json");
  // Set before the first byte: the compression middleware leaves an already-encoded body alone.
  res.setHeader("Content-Encoding", "gzip");
  res.setHeader("Vary", "Accept-Encoding");
}

/**
 * Serve a kept body. Returns false (nothing written) when none is kept under `key`. A body another
 * read is building under the same key is waited for (bounded), then replayed: ten readers of a
 * version that just moved build it once, not ten times.
 */
export async function replayGzipBody(key: string, res: Response): Promise<boolean> {
  let entry = entries.get(key);
  const pending = entry ? undefined : building.get(key);
  if (pending) {
    await Promise.race([pending, new Promise((resolve) => setTimeout(resolve, BUILD_WAIT_MS).unref())]);
    entry = entries.get(key);
  }
  if (!entry) return false;
  entries.delete(key);
  entries.set(key, entry);
  gzipHeaders(res);
  res.setHeader("Content-Length", String(entry.bytes));
  for (const chunk of entry.chunks) {
    if (res.destroyed) return true;
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          res.off("drain", done);
          res.off("close", done);
          resolve();
        };
        res.on("drain", done);
        res.on("close", done);
      });
    }
  }
  if (!res.writableEnded) res.end();
  return true;
}

/**
 * A gzip stream the route writes its JSON into, piped to the response and recorded under `key`
 * once it ENDS whole (a body cut short by a caller who left, or by an error, is never kept).
 * Shaped like the response for `ResponseWriter`: write/end, `drain`, `close`, `destroyed`.
 */
export function recordingGzip(key: string, res: Response): Gzip {
  gzipHeaders(res);
  const gzip = createGzip();
  let settle: () => void = () => undefined;
  if (!building.has(key)) {
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    building.set(key, done);
    gzip.once("close", () => {
      if (building.get(key) === done) building.delete(key);
      settle();
    });
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  gzip.on("data", (chunk: Buffer) => {
    if (overflow) return;
    bytes += chunk.length;
    if (bytes > MAX_ENTRY_BYTES) {
      overflow = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  gzip.on("end", () => {
    if (!overflow && !res.destroyed) remember(key, { chunks, bytes });
    settle();
  });
  // A caller who left stops the gzip stream too, so a writer waiting on its `drain` wakes.
  res.once("close", () => {
    if (!gzip.writableEnded) gzip.destroy();
  });
  gzip.pipe(res);
  return gzip;
}
