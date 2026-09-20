/**
 * What a streamed response is allowed to hold while the consumer is slower than the database.
 *
 * `res.write()` returning `false` is the socket saying it is full; ignoring it turns a streamed
 * response back into an in-memory one, with the buffered bytes growing as the difference between
 * how fast rows are produced and how fast they leave. That is the same failure as holding the
 * population, one layer down — so the writer must WAIT, and it must not wait forever on a socket
 * that has gone away.
 */
import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { ResponseWriter } from "../../src/lib/stream-writer.js";
import type { ServerResponse } from "node:http";

class FakeSocket extends EventEmitter {
  writes: string[] = [];
  full = false;
  writableEnded = false;
  destroyed = false;
  write(payload: string): boolean {
    this.writes.push(payload);
    return !this.full;
  }
  end(): void {
    this.writableEnded = true;
  }
}

const writerFor = (socket: FakeSocket) => new ResponseWriter(socket as unknown as ServerResponse);

describe("writing a long response", () => {
  it("batches small pieces rather than one write per row", async () => {
    const socket = new FakeSocket();
    const writer = writerFor(socket);
    for (let i = 0; i < 50; i += 1) await writer.write("x".repeat(100));
    expect(socket.writes).toHaveLength(0);
    await writer.end();
    expect(socket.writes).toHaveLength(1);
    expect(socket.writes[0]).toHaveLength(5_000);
  });

  it("flushes on its own once a batch is full, without being told to", async () => {
    const socket = new FakeSocket();
    const writer = writerFor(socket);
    await writer.write("x".repeat(64 * 1024 + 1));
    expect(socket.writes).toHaveLength(1);
  });

  it("WAITS for the socket to drain when it says it is full", async () => {
    const socket = new FakeSocket();
    socket.full = true;
    const writer = writerFor(socket);
    const settled = vi.fn();
    const pending = writer.write("x".repeat(64 * 1024 + 1)).then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    socket.emit("drain");
    await pending;
    expect(settled).toHaveBeenCalled();
  });

  it("does not wait forever on a socket that has gone away", async () => {
    const socket = new FakeSocket();
    socket.full = true;
    const writer = writerFor(socket);
    const pending = writer.write("x".repeat(64 * 1024 + 1));
    // A destroyed socket never emits `drain`; waiting on that alone would hang the request and
    // hold its database connection with it.
    socket.emit("close");
    await expect(pending).resolves.toBeUndefined();
  });

  it("writes nothing more once the response has ended", async () => {
    const socket = new FakeSocket();
    const writer = writerFor(socket);
    await writer.write("first");
    await writer.end();
    expect(socket.writes).toEqual(["first"]);
    await writer.write("second");
    await writer.flush();
    expect(socket.writes).toEqual(["first"]);
  });

  it("emits every piece exactly once, in order", async () => {
    const socket = new FakeSocket();
    const writer = writerFor(socket);
    const pieces = Array.from({ length: 2_000 }, (_, i) => `row-${i}\n`);
    for (const piece of pieces) await writer.write(piece);
    await writer.end();
    expect(socket.writes.join("")).toBe(pieces.join(""));
  });
});
