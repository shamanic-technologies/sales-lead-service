/**
 * The first words of a Unibox row's LAST message (UNIBOX-LAST-MESSAGE-PREVIEW-1021, owner 2026-10-21: scan the
 * Unibox like Gmail, one line under the name with the start of the latest message, ours or theirs). The message
 * itself is crm-service's (it keeps the thread); this module only cuts its text into one line: quoted history and
 * signature dropped when they are recognizable, whitespace folded, cut on a word near `PREVIEW_MAX_CHARS`.
 * A text that leaves nothing = null (the caller says why).
 */

export const PREVIEW_MAX_CHARS = 160;

/** A line where the quoted history of an email starts (everything from it on is somebody's older words). */
const QUOTE_HEADER = [
  /^on .{3,200}\bwrote:?\s*$/i,
  /^le .{3,200}\ba écrit\s*:?\s*$/i,
  /^am .{3,200}\bschrieb .{0,100}:?\s*$/i,
  /^el .{3,200}\bescribió:?\s*$/i,
  /^-{2,}\s*original message\s*-{2,}$/i,
  /^-{2,}\s*message d'origine\s*-{2,}$/i,
  /^_{8,}$/,
  /^from:\s.+$/i,
  /^de\s?:\s.+@.+$/i,
];

/** A line where the signature starts (the sender's name and links, not what they said). */
const SIGNATURE_START = [/^--\s*$/, /^sent from my /i, /^envoyé de mon /i, /^get outlook for /i];

/** Cut a message text into its preview line; null when nothing of the sender's own words is left. */
export function messagePreview(text: string | null | undefined, max: number = PREVIEW_MAX_CHARS): string | null {
  if (typeof text !== "string") return null;
  const kept: string[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (QUOTE_HEADER.some((r) => r.test(line)) || SIGNATURE_START.some((r) => r.test(line))) break;
    if (line.startsWith(">")) continue;
    kept.push(line);
  }
  const flat = kept.join(" ").replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}
