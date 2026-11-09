/**
 * DASH-SPEED-1110: `SELECT id::text AS id ... ORDER BY id` orders by the TEXT alias, not the column. Postgres resolves a
 * bare ORDER BY name to the output column first, so:
 *   - a uuid ordered as text cannot walk the primary key: the change feed's snapshot re-read and sorted the whole scope
 *     for every 1,000-row chunk (967 ms a chunk vs 25 ms);
 *   - a bigint ordered as text puts "1000" before "999": a keyset (`seq > $after ... LIMIT n`) then skips rows at a
 *     digit boundary.
 * Order by the qualified column (`ORDER BY t.seq`). A statement that needs the alias on purpose is listed below.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../src");

/** `file:column` pairs where ordering by the text alias is harmless (no keyset, no index walk) or required (DISTINCT). */
const ALLOWED = new Set(["lib/brand-signups.ts:lead_id", "lib/outcome-cause.ts:lead_id"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** Every `<col>::text AS <col>` whose statement (up to the template's closing backtick) orders by bare `<col>`. */
function textAliasOrderings(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/\b(\w+)::text AS (\w+)\b/g)) {
    if (m[1] !== m[2]) continue;
    const col = m[1];
    const rest = source.slice(m.index! + m[0].length);
    const end = rest.search(/(?<!\\)`/);
    const statement = end === -1 ? rest : rest.slice(0, end);
    if (new RegExp(`ORDER BY\\s+${col}\\b(?!\\s*::)`).test(statement)) found.push(col);
  }
  return found;
}

describe("ORDER BY never names a ::text alias of the column it sorts (DASH-SPEED-1110)", () => {
  it("detects the forbidden form and accepts the qualified one", () => {
    expect(textAliasOrderings("sql`SELECT seq::text AS seq FROM t WHERE seq > 1 ORDER BY seq LIMIT 5`")).toEqual(["seq"]);
    expect(textAliasOrderings("sql`SELECT seq::text AS seq FROM t WHERE seq > 1 ORDER BY t.seq LIMIT 5`")).toEqual([]);
  });

  it("no statement in src orders by a ::text alias", () => {
    const offenders: string[] = [];
    for (const file of files(ROOT)) {
      const rel = relative(ROOT, file);
      for (const col of textAliasOrderings(readFileSync(file, "utf8"))) {
        if (!ALLOWED.has(`${rel}:${col}`)) offenders.push(`${rel}:${col}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
