/**
 * Writing a long response WITHOUT letting it pile up in this process.
 *
 * `res.write()` never blocks: when the socket cannot take the bytes — a consumer on the other side
 * of two proxies and the public internet routinely cannot, at the speed a database can produce
 * rows — Node buffers them and returns `false`. Ignoring that return is how a streamed response
 * becomes an in-memory one: the walk runs at database speed, the socket drains at network speed,
 * and the difference accumulates as heap. It is the same failure as holding the population, one
 * layer down, and it grows with exactly the same thing.
 *
 * So this writer does two things: it batches small pieces into one write (a per-row `write()` of a
 * 600-byte CSV line is a syscall per lead), and it WAITS for `drain` when the socket says it is
 * full. Peak buffered bytes is then the high-water mark plus one batch, whatever the response's
 * total size.
 */
import type { ServerResponse } from "node:http";

/** How many bytes are batched before a write, and the ceiling the socket is allowed to hold. */
const BATCH_BYTES = 64 * 1024;

/**
 * Waiting for the socket to drain, or for it to end.
 *
 * A destroyed socket never emits `drain`, so waiting on that alone would hang the request forever
 * and hold its database connection with it — the exact shape of the 2026-09-07 pool exhaustion.
 * `close` and `error` therefore resolve it too: the writes that follow are no-ops on a dead socket,
 * and the walk's own abandonment check (see client-abort.ts) is what ends the read.
 *
 * The writer subscribes ONCE, for the life of the response, rather than once per wait. The
 * `compression` middleware hands `drain` subscriptions to its gzip stream but never forwards their
 * removal, so a per-wait `once`/`off` pair left one listener behind on that stream per wait
 * (`MaxListenersExceededWarning: 11 drain listeners added to [Gzip]` on every large compact walk).
 */
export class ResponseWriter {
  private pending: string[] = [];
  private pendingBytes = 0;

  /** Resolves the wait in progress, if any. */
  private wake: (() => void) | null = null;

  constructor(private readonly res: ServerResponse) {
    const wake = () => {
      const resolve = this.wake;
      this.wake = null;
      resolve?.();
    };
    res.on("drain", wake);
    res.once("close", wake);
    res.once("error", wake);
  }

  private drained(): Promise<void> {
    if (this.res.destroyed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.wake = resolve;
    });
  }

  /** Queue a piece of the response, flushing (and waiting on the socket) once a batch is full. */
  async write(text: string): Promise<void> {
    this.pending.push(text);
    this.pendingBytes += text.length;
    if (this.pendingBytes >= BATCH_BYTES) await this.flush();
  }

  /** Write whatever is queued, and wait for the socket if it says it is full. */
  async flush(): Promise<void> {
    if (this.pendingBytes === 0) return;
    const payload = this.pending.join("");
    this.pending = [];
    this.pendingBytes = 0;
    if (this.res.writableEnded || this.res.destroyed) return;
    if (!this.res.write(payload)) await this.drained();
  }

  /** Flush the tail and close the response. */
  async end(): Promise<void> {
    await this.flush();
    if (!this.res.writableEnded) this.res.end();
  }
}
