/**
 * LEAD-CI-FLAKY-1110: wait until every transaction open NOW (anywhere on the server) has ended.
 *
 * The change logs (`acted_input_changes`, `journey_input_changes`, `lead_read_changes`) count a change as "maybe not
 * seen" when its txid is at or above the snapshot xmin a pass took before reading. That xmin is the OLDEST transaction
 * still open on the whole server, so while another integration file (they share one database and run at once) holds
 * a transaction, our OWN earlier, committed writes still read as "maybe not seen" and the scope is re-derived. Correct
 * and conservative in the code; a race in a test asserting "nothing moved". A test that asserts a pass sees nothing
 * new settles first: the pass after it takes an xmin above every write the test made. Fails loud past the timeout
 * (naming who holds it), never a silent wait.
 */
import { sql as sqlTag } from "drizzle-orm";

type Exec = { execute: (q: ReturnType<typeof sqlTag>) => Promise<unknown> };

export async function settleOpenTransactions(db: Exec, timeoutMs = 60_000): Promise<void> {
  const [{ xmax }] = (await db.execute(sqlTag`SELECT pg_snapshot_xmax(pg_current_snapshot())::text AS xmax`)) as Array<{ xmax: string }>;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [{ settled }] = (await db.execute(
      sqlTag`SELECT pg_snapshot_xmin(pg_current_snapshot()) >= ${xmax}::xid8 AS settled`,
    )) as Array<{ settled: boolean }>;
    if (settled) return;
    if (Date.now() > deadline) {
      const holders = await db.execute(sqlTag`
        SELECT pid, backend_xid::text AS xid, state, left(query, 200) AS query FROM pg_stat_activity WHERE backend_xid IS NOT NULL`);
      throw new Error(`transactions open before ${xmax} still running after ${timeoutMs} ms: ${JSON.stringify(holders)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
