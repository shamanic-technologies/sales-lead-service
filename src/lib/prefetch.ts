/**
 * Pull the NEXT item of an async source while the consumer is still working on the current one.
 *
 * A whole-population lead walk alternates two waits that do not depend on each other: the database
 * producing the next chunk, and email-gateway answering for the chunk in hand. Run back to back they
 * add up; with one chunk of read-ahead they overlap. Exactly ONE item is ever held ahead, so memory
 * stays one chunk, not the population.
 *
 * Nothing is swallowed: a source that throws throws at the consumer's next pull, exactly where it
 * would have without the read-ahead. And the source is always closed when the consumer stops — early
 * or not — because closing it is what hands a database cursor's connection back.
 */
export async function* prefetchOne<T>(source: AsyncIterable<T>): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let pending = iterator.next();
  // The consumer may stop before awaiting the read-ahead; its failure must not become an unhandled
  // rejection. It is still surfaced on the `await` below whenever the consumer does pull it.
  pending.catch(() => {});
  let finished = false;
  try {
    for (;;) {
      const result = await pending;
      if (result.done) {
        finished = true;
        return;
      }
      pending = iterator.next();
      pending.catch(() => {});
      yield result.value;
    }
  } finally {
    if (!finished) await iterator.return?.();
  }
}
