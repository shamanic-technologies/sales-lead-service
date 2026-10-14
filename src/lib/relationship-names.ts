/**
 * Which known people could an unlinked person be? (RELATIONSHIP-TAGS-1014). Pure.
 *
 * This is BLOCKING, never a judgment: it only picks the few known people worth asking Jev about, so a
 * "Yulia (WA)" seen on WhatsApp is compared with "Yuliia Siletska" (signup) and not with 9,000 others.
 * Names are folded across alphabets and spellings (Cyrillic to Latin, accents dropped, j/y/i treated
 * alike, vowels after the first letter ignored), then compared token by token; the shorter skeleton
 * may be a prefix of the longer one (Dima / Dmytro). Whether they ARE the same person is Jev's answer.
 */

const CYRILLIC: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ye", ё: "yo", ж: "zh", з: "z", и: "y", і: "i", ї: "yi",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh",
  ц: "ts", ч: "ch", ш: "sh", щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
};

/** Lowercase Latin letters only, Cyrillic transliterated, accents dropped. */
export function foldLetters(s: string): string {
  const lower = s.toLowerCase();
  let out = "";
  for (const ch of lower) out += CYRILLIC[ch] ?? ch;
  return out.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

const NOISE_TOKENS = new Set(["wa", "whatsapp", "linkedin", "li", "tg", "telegram", "mr", "mrs", "ms", "dr", "pro", "perso", "personal", "work"]);

/** The name tokens of a display name or an email local part ("lusenko.julija" -> lusenko, julija). */
export function nameTokens(name: string | null | undefined): string[] {
  if (!name) return [];
  return foldLetters(name)
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2 && !NOISE_TOKENS.has(t));
}

/** First letter + consonants, with j/y/i folded together: yulia, yuliia, julija, juliya -> "yl". */
export function skeleton(token: string): string {
  const t = token.replace(/j/g, "y").replace(/w/g, "v").replace(/ph/g, "f").replace(/ck/g, "k").replace(/c/g, "k");
  if (t.length === 0) return "";
  let out = t[0];
  for (const ch of t.slice(1)) {
    if ("aeiouyh".includes(ch)) continue;
    if (out[out.length - 1] === ch) continue;
    out += ch;
  }
  return out;
}

function skeletonsMatch(a: string, b: string): boolean {
  if (a.length < 2 || b.length < 2) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return long.startsWith(short) && short.length >= 2;
}

export interface NamedPerson {
  humanId: string;
  name: string | null;
  emails: readonly string[];
}

export function tokensOf(p: NamedPerson): string[] {
  const t = new Set(nameTokens(p.name));
  for (const e of p.emails) for (const x of nameTokens(e.split("@")[0])) t.add(x);
  return [...t];
}

/**
 * A score for how worth asking a pair is (0 = not a candidate). The FIRST token of the unlinked name
 * must match some token of the known person; each matching token adds weight (a last name), each token
 * of the unlinked name the known person does not carry takes some away ("Yulia (WA)" fits Yuliia Siletska
 * better than "Julia Smith" does).
 */
export function pairScore(unlinked: NamedPerson, known: NamedPerson): number {
  return scoreAgainst(nameTokens(unlinked.name), tokensOf(known).map(skeleton));
}

/** `u` = the unlinked name's tokens, `k` = the known person's token skeletons (precomputed once per sweep). */
function scoreAgainst(u: readonly string[], k: readonly string[]): number {
  if (u.length === 0) return 0;
  const first = skeleton(u[0]);
  if (!k.some((x) => skeletonsMatch(first, x))) return 0;
  let score = 2;
  for (const tok of u.slice(1)) score += k.some((x) => skeletonsMatch(skeleton(tok), x)) ? 2 : -1;
  if (k.includes(first)) score += 0.5;
  return Math.max(score, 0.1);
}

/** The best known candidates for one unlinked person, at most `max`, best first. */
export interface KnownIndexEntry {
  person: NamedPerson;
  skeletons: string[];
}

/** The known people with their name skeletons, computed once for a whole sweep. */
export function indexKnown(known: readonly NamedPerson[]): KnownIndexEntry[] {
  return known.map((person) => ({ person, skeletons: tokensOf(person).map(skeleton) }));
}

export function candidatesFor(
  unlinked: NamedPerson,
  known: readonly NamedPerson[] | readonly KnownIndexEntry[],
  max = 5,
): Array<{ person: NamedPerson; score: number }> {
  const index: readonly KnownIndexEntry[] =
    known.length > 0 && "skeletons" in (known[0] as object) ? (known as readonly KnownIndexEntry[]) : indexKnown(known as readonly NamedPerson[]);
  const u = nameTokens(unlinked.name);
  return index
    .filter((k) => k.person.humanId !== unlinked.humanId)
    .map((k) => ({ person: k.person, score: scoreAgainst(u, k.skeletons) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.person.humanId.localeCompare(b.person.humanId))
    .slice(0, max);
}

/**
 * From the KNOWN side: for each known person, the best unlinked candidates (at most `max`). The known side is
 * small (people with an address), the unlinked side can be a whole WhatsApp group roster.
 */
export function unlinkedCandidatesFor(
  known: NamedPerson,
  unlinked: ReadonlyArray<{ person: NamedPerson; tokens: string[] }>,
  max = 3,
): Array<{ person: NamedPerson; score: number }> {
  const k = tokensOf(known).map(skeleton);
  return unlinked
    .map((u) => ({ person: u.person, score: scoreAgainst(u.tokens, k) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.person.humanId.localeCompare(b.person.humanId))
    .slice(0, max);
}

/** A display name that is only a phone number or empty carries no name to compare. */
export function hasComparableName(name: string | null): boolean {
  return nameTokens(name).length > 0;
}
