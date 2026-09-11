import { describe, it, expect } from "vitest";
import {
  LinkDestinationIndex,
  destinationKey,
  extractUrls,
  resolveMessageLinks,
} from "../../src/lib/message-links.js";

describe("extractUrls", () => {
  it("leaves the sentence's punctuation out of the URL", () => {
    expect(extractUrls("go to https://a.com/x, then https://b.com/y.")).toEqual([
      "https://a.com/x",
      "https://b.com/y",
    ]);
  });

  it("reads a URL out of an href without swallowing the quote", () => {
    expect(extractUrls('<a href="https://a.com/x?u=1">click</a>')).toEqual(["https://a.com/x?u=1"]);
  });

  it("answers nothing for no body at all", () => {
    expect(extractUrls(null)).toEqual([]);
  });
});

describe("destinationKey", () => {
  it("ignores exactly what the sender strips — the query string", () => {
    expect(destinationKey("https://a.com/x?utm_id=1")).toBe(destinationKey("https://a.com/x"));
  });

  it("treats host case, a leading www. and a trailing slash as spelling", () => {
    expect(destinationKey("https://WWW.A.com/x/")).toBe(destinationKey("https://a.com/x"));
  });

  it("resolves a string that is not a URL to nothing", () => {
    expect(destinationKey("not a url")).toBeNull();
    expect(destinationKey("mailto:someone@example.com")).toBeNull();
  });
});

describe("resolveMessageLinks", () => {
  it("gives the destination we wrote back, tracking parameters included", () => {
    const index = new LinkDestinationIndex();
    index.add("see https://a.com/x?utm_id=distribute");
    expect(resolveMessageLinks("see https://a.com/x", index)).toEqual([
      { text: "https://a.com/x", href: "https://a.com/x?utm_id=distribute" },
    ]);
  });

  it("states a link we never wrote with only its text", () => {
    const index = new LinkDestinationIndex();
    index.add("see https://a.com/x?utm_id=distribute");
    expect(resolveMessageLinks("see https://click.provider.io/t/abc", index)).toEqual([
      { text: "https://click.provider.io/t/abc", href: null },
    ]);
  });

  it("counts one link written twice as one link", () => {
    const index = new LinkDestinationIndex();
    index.add("https://a.com/x?utm_id=distribute");
    expect(resolveMessageLinks("https://a.com/x and again https://a.com/x", index)).toHaveLength(1);
  });

  it("does not choose between two parameterizations of one page", () => {
    const index = new LinkDestinationIndex();
    index.add("https://a.com/x?utm_id=one https://a.com/x?utm_id=two");
    expect(resolveMessageLinks("https://a.com/x", index)).toEqual([
      { text: "https://a.com/x", href: null },
    ]);
  });

  it("reads the same URL written twice in the copy as one destination", () => {
    const index = new LinkDestinationIndex();
    index.add("https://a.com/x?utm_id=one and https://a.com/x?utm_id=one");
    expect(index.size).toBe(1);
    expect(resolveMessageLinks("https://a.com/x", index)[0].href).toBe("https://a.com/x?utm_id=one");
  });
});
