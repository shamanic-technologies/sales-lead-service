/**
 * Which human-service PERSON a served lead is: the id human-service gives the
 * canonical person row it resolves (or creates) when it serves someone from an
 * audience (`people.id`, the same id its audience-members read calls `personId`).
 *
 * The email stack records this as the durable identity of the person it
 * contacted, separately from `leadId` (this service's lead / provenance id). The
 * two are different concepts and may differ for the same human: nothing here ever
 * derives, aliases or defaults one from the other.
 *
 * Carried, never derived. Absent stays absent (`null`, omitted on the wire): a
 * serve whose producer did not state a person is still a serve. A value that is
 * present but not a UUID is a producer contract break and THROWS, before anything
 * is written, like a malformed buying signal.
 *
 * This module must not import the database: `src/schemas.ts` (and the OpenAPI
 * generator, which runs with no database configured) may reach it.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readServedPersonId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !UUID_RE.test(raw)) {
    throw new Error(
      `[lead-service] malformed personId from human-service serve-next: ${JSON.stringify(raw)}`,
    );
  }
  return raw.toLowerCase();
}
