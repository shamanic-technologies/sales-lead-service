import { describe, expect, it } from "vitest";
import { orderByEmptyAnswers } from "../../src/lib/source-audience-walk.js";

describe("orderByEmptyAnswers (CATCHALL-NEVER-SOURCED-1014)", () => {
  it("asks audiences with no empty answer first, in their order, then the dry ones oldest answer first", () => {
    const empty = new Map([
      ["a", 3_000],
      ["c", 1_000],
    ]);
    expect(orderByEmptyAnswers(["a", "b", "c", "d"], empty)).toEqual(["b", "d", "c", "a"]);
  });
  it("never drops an audience", () => {
    const ids = ["x", "y", "z"];
    const empty = new Map(ids.map((id, i) => [id, i]));
    expect([...orderByEmptyAnswers(ids, empty)].sort()).toEqual([...ids].sort());
    expect(orderByEmptyAnswers(ids, new Map())).toEqual(ids);
  });
});
