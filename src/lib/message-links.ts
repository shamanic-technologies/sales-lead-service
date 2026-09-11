/**
 * WHERE A LINK IN A MESSAGE WE HOLD ACTUALLY LEADS.
 *
 * The copy we generate carries a destination with our tracking parameters on it. By the time the
 * message is read back off the outreach provider, two things have happened to that link: the
 * sending side strips the parameters from the VISIBLE text (so the prospect reads a clean URL),
 * and the underlying destination is replaced by the provider's own click-tracking redirect. So the
 * body we hold carries only the clean URL as plain text — our parameters are nowhere in it, and
 * the real destination is nowhere in it either. A reader who wants to see where the link went, or
 * to follow it, cannot.
 *
 * Nothing new is fetched to answer that: the generated copy this service already reads carries the
 * SAME URL with its parameters, so the destination is resolved against it.
 *
 * Three things are load-bearing.
 *
 * (1) **A destination is only ever a URL WE WROTE.** `href` comes from the generated copy and from
 *     nowhere else. The provider's click-tracking redirect is therefore unreachable here by
 *     construction — it appears in no generated copy — which is what keeps a dashboard from
 *     following it and registering a click the prospect never made.
 *
 * (2) **NOTHING IS INVENTED.** A link that does not match a URL we wrote, or that matches SEVERAL
 *     different ones, is stated with `href: null` — the text the reader saw and an honest "we
 *     cannot say where this went". Guessing which of two parameterizations was the one sent would
 *     be making up tracking parameters for a link we cannot resolve.
 *
 * (3) **THE MATCH IGNORES ONLY WHAT THE SENDER STRIPS.** Origin and path identify the destination;
 *     the query string is exactly the part that was removed, so it is what the match must not
 *     depend on. Host case and a leading `www.` are spelling, and a trailing slash on a path is
 *     spelling too.
 */

/** One link as the prospect saw it, and where it truly leads when we can say. */
export interface MessageLink {
  /** The link's text, verbatim as it appears in the body the prospect read. */
  text: string;
  /** The destination we wrote, tracking parameters included. Null when it cannot be resolved to a
   * URL we wrote — never a guess, and never the provider's click-tracking redirect. */
  href: string | null;
}

/** Trailing punctuation belongs to the sentence, not to the URL. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"»>]+$/;

const URL_RE = /https?:\/\/[^\s<>"'`\\]+/gi;

function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const trimmed = url.replace(TRAILING_PUNCTUATION, "");
    if (trimmed === url) return trimmed;
    url = trimmed;
  }
}

/** Every http(s) URL in a blob of text or HTML, in the order it appears, verbatim. */
export function extractUrls(text: string | null | undefined): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const url = trimUrl(match[0]);
    if (url.length > 0) found.push(url);
  }
  return found;
}

/**
 * What identifies a destination once the sender has stripped the query string: origin and path.
 * Null when the string is not a URL at all — an unparseable link resolves to nothing rather than
 * to a key that could collide with a real one.
 */
export function destinationKey(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = parsed.host.toLowerCase().replace(/^www\./, "");
  const path = parsed.pathname.replace(/\/+$/, "");
  return `${host}${path}`;
}

/**
 * The destinations we wrote, indexed by what survives the sender stripping the parameters.
 *
 * A key holding several DIFFERENT full URLs is ambiguous and resolves to nothing: two steps of a
 * sequence pointing at the same page with different parameters give no honest way to say which one
 * a given message carried.
 */
export class LinkDestinationIndex {
  private readonly byKey = new Map<string, Set<string>>();

  /** Every URL in one blob of generated copy. Repeats of the same URL are one destination. */
  add(text: string | null | undefined): void {
    for (const url of extractUrls(text)) {
      const key = destinationKey(url);
      if (!key) continue;
      const existing = this.byKey.get(key);
      if (existing) existing.add(url);
      else this.byKey.set(key, new Set([url]));
    }
  }

  /** The destination for one link the prospect saw, or null when we cannot say. */
  resolve(url: string): string | null {
    const key = destinationKey(url);
    if (!key) return null;
    const candidates = this.byKey.get(key);
    if (!candidates || candidates.size !== 1) return null;
    return [...candidates][0];
  }

  get size(): number {
    return this.byKey.size;
  }
}

/**
 * The links in a message we hold: what the reader saw, and where each truly leads.
 *
 * The same link written twice in one body is one entry — a consumer renders a list of the links in
 * the message, not a list of the times a string occurs.
 */
export function resolveMessageLinks(
  bodyText: string | null | undefined,
  index: LinkDestinationIndex,
): MessageLink[] {
  const links: MessageLink[] = [];
  const seen = new Set<string>();
  for (const text of extractUrls(bodyText)) {
    if (seen.has(text)) continue;
    seen.add(text);
    links.push({ text, href: index.resolve(text) });
  }
  return links;
}
