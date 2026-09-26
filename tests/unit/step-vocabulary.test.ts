import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * This service neither reads a sales funnel nor serves one (wave C3, distribute.you#4413), and it
 * never called one a "chain" either.
 *
 * The fleet retired the sales funnel: org > brand > offer > outcome > leg, and a campaign is
 * (offer x leg x channel). The order between steps is the leg graph (src/lib/step-graph.ts). The
 * second half of this file is the older guard below, kept because the same reasoning applies.
 *
 * A sales funnel was never a "chain" either.
 *
 * The word was this fleet's second name for the same thing. features-service, api-service and all
 * three dashboard apps dropped it first; this service was the last producer still SERVING it,
 * which is the only reason the two consumer apps ever read it. v0.62.0 renamed the payload
 * (`chain` -> `funnelSteps`, `inChain` -> `inFunnel`, `chainIndex` -> `stepIndex`) without moving
 * any data — same steps, same order, same semantics.
 *
 * A sweep is only as durable as the guard behind it, and this is the guard. It fails the build on
 * the word returning to a property name, to a published description, or to any source file — which
 * is what makes "no alias, and it does not come back" a property of the repo rather than a promise
 * in a commit message.
 *
 * The carve-out is the word used for something that genuinely is NOT a sales funnel: a CALL chain,
 * a CAUSE chain, the SEND chain a lead is handed to. Those are allowed by exact phrase, never by
 * proximity, so "sales chain" can never slip through on the back of one.
 */
const BANNED = ["ch", "ain"].join("");
const ALLOWED_PHRASES = ["call chain", "cause chain", "send chain", "promise chain"];
const REPO = fileURLToPath(new URL("../..", import.meta.url));

/** This file names what it forbids, so it is the one file exempt from its own scan. */
const SELF = "tests/unit/step-vocabulary.test.ts";

/** The retired sales-funnel surface, spelled so this file does not match itself. */
const RETIRED_FUNNEL = new RegExp(["funnel", "Key|funnel_", "key|sales-", "funnels|sales", "Funnel"].join(""), "i");

function stripAllowed(text: string): string {
  let out = text.toLowerCase();
  for (const phrase of ALLOWED_PHRASES) out = out.split(phrase).join("");
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "meta") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs|sql|json)$/.test(entry)) out.push(full);
  }
  return out;
}

function walkSpec(
  node: unknown,
  path: string,
  visit: (path: string, key: string, value: unknown) => void,
) {
  if (Array.isArray(node)) {
    node.forEach((child, i) => walkSpec(child, `${path}[${i}]`, visit));
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      visit(path, key, value);
      walkSpec(value, `${path}.${key}`, visit);
    }
  }
}

describe("the published contract never calls a sales funnel a chain", () => {
  const spec = JSON.parse(readFileSync(join(REPO, "openapi.json"), "utf8"));

  it("names no property with the retired word", () => {
    const offenders: string[] = [];
    walkSpec(spec, "$", (path, key) => {
      if (path.endsWith(".properties") && key.toLowerCase().includes(BANNED)) {
        offenders.push(`${path}.${key}`);
      }
    });
    expect(offenders).toEqual([]);
  });

  it("uses the word in no description that is not about one of the allowed things", () => {
    const offenders: string[] = [];
    walkSpec(spec, "$", (path, key, value) => {
      if (key !== "description" && key !== "summary") return;
      if (typeof value !== "string") return;
      if (stripAllowed(value).includes(BANNED)) offenders.push(`${path}.${key}`);
    });
    expect(offenders).toEqual([]);
  });

});

describe("no sales funnel is read or served", () => {
  const spec = JSON.parse(readFileSync(join(REPO, "openapi.json"), "utf8"));

  it("publishes no funnel property and no funnel parameter", () => {
    const offenders: string[] = [];
    walkSpec(spec, "$", (path, key, value) => {
      if (path.endsWith(".properties") && /funnel/i.test(key)) offenders.push(`${path}.${key}`);
      if (key === "name" && typeof value === "string" && /funnel/i.test(value)) offenders.push(`${path}.name=${value}`);
    });
    expect(offenders).toEqual([]);
  });

  it("serves the campaign's leg on a lead's standing instead", () => {
    const standing = spec.components.schemas.LeadStanding?.properties ?? {};
    expect(Object.keys(standing)).toContain("legKey");
  });

  it("names the retired surface in no source file", () => {
    const offenders: string[] = [];
    for (const file of walk(join(REPO, "src"))) {
      if (RETIRED_FUNNEL.test(readFileSync(file, "utf8"))) offenders.push(file.slice(REPO.length));
    }
    expect(offenders).toEqual([]);
  });
});

describe("no source file calls a sales funnel a chain either", () => {
  it("carries the word only where the thing is genuinely not a sales funnel", () => {
    const offenders: string[] = [];
    for (const dir of ["src", "tests", "scripts", "drizzle"]) {
      for (const file of walk(join(REPO, dir))) {
        const rel = file.slice(REPO.length);
        if (rel === SELF) continue;
        if (stripAllowed(readFileSync(file, "utf8")).includes(BANNED)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
