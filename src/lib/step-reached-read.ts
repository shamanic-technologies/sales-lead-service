/**
 * The IO half of "who reached step S at brand B" (rules in `step-reached.ts`). Two statements, one per store,
 * bounded by the (org, brand), the step's types and either the window (`since`) or one exact address (`email`);
 * then ONE enrichment read of the brand's CRM copy for people the reach rows named without a name or a phone.
 *
 * FAIL LOUD: the CRM copy not caught up yet (it would answer "nobody" for people it has not copied) throws
 * `CrmFactFeedNotCaughtUpError`; any database error throws. Never an empty answer on a failure.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { toIsoTimestamp, type RawTimestamp } from "./basic-leads.js";
import { CrmFactFeedNotCaughtUpError } from "./crm-fact-events.js";
import { PEOPLE_FACTS_FEED } from "./crm-fact-feed.js";
import {
  STEP_REACHED_EVIDENCE,
  groupReachedPeople,
  type ReachRow,
  type ReachedPerson,
} from "./step-reached.js";
import { crmFactHasEmail } from "./crm-fact-contact.js";
import { HELD_GRACE_MS, MEETING_HELD_STEP } from "./meeting-held.js";
import { readHeldMeetings } from "./meeting-held-read.js";

/** A held meeting is read back this long before the window by its start (it is held at its end, later). */
const HELD_MEETING_START_LOOKBACK_MS = 24 * 60 * 60_000;

export type StepReachedQuery =
  | { orgId: string; brandId: string; step: string; since: string; email?: undefined }
  | { orgId: string; brandId: string; step: string; email: string; since?: undefined };

interface RawReachRow {
  emails: string[] | null;
  name: string | null;
  phones: string[] | null;
  at: RawTimestamp;
  type: string;
  payload: Record<string, unknown> | null;
}

function toReachRow(r: RawReachRow): ReachRow {
  return {
    emails: r.emails ?? [],
    name: r.name,
    phones: r.phones ?? [],
    at: r.at === null ? null : toIsoTimestamp(r.at),
    type: r.type,
    payload: r.payload,
  };
}

async function assertCrmCopyCaughtUp(): Promise<void> {
  const cursor = (await db.execute(sql`
    SELECT caught_up_at FROM crm_feed_cursors WHERE feed = ${PEOPLE_FACTS_FEED}
  `)) as unknown as Array<{ caught_up_at: RawTimestamp }>;
  if (cursor.length === 0 || cursor[0].caught_up_at === null) throw new CrmFactFeedNotCaughtUpError();
}

/** The people who reached the step: in the window (since mode), or that one address at any time (email mode). */
export async function readStepReached(q: StepReachedQuery): Promise<ReachedPerson[]> {
  const evidence = STEP_REACHED_EVIDENCE[q.step];
  if (!evidence) throw new Error(`step-reached: unanswerable step "${q.step}" reached the read`);
  await assertCrmCopyCaughtUp();

  const email = q.email === undefined ? null : q.email;
  const crmWindow =
    email === null
      ? sql`AND f.occurred_at >= ${q.since}::timestamptz`
      : sql`AND ${crmFactHasEmail("f", email)}`;

  const crmRows = (await db.execute(sql`
    SELECT f.emails, f.full_name AS name, f.phones, f.occurred_at AS at, f.type, f.payload
    FROM crm_facts f
    WHERE f.org_id = ${q.orgId}
      AND f.brand_id = ${q.brandId}
      AND f.type = ANY(${sql.param([...evidence.crmFactTypes])}::text[])
      AND cardinality(f.emails) > 0
      ${crmWindow}
      AND NOT EXISTS (
        SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id
      )
  `)) as unknown as RawReachRow[];

  // The ledger: the event's own reported address, plus the matched lead's registered addresses when attributed.
  const ledgerRows = (await db.execute(sql`
    SELECT * FROM (
      SELECT
        ARRAY(
          SELECT lower(trim(x.v)) FROM (
            SELECT ce.email AS v, 0 AS o
            UNION ALL
            SELECT cm.value, 1 FROM lead_contact_methods cm
            WHERE ce.attribution_status = 'attributed' AND cm.lead_id = ce.matched_lead_id AND cm.channel = 'email'
          ) x
          WHERE x.v IS NOT NULL AND trim(x.v) <> ''
          ORDER BY x.o, lower(trim(x.v))
        ) AS emails,
        NULLIF(trim(concat_ws(' ', COALESCE(ce.first_name, l.first_name), COALESCE(ce.last_name, l.last_name))), '') AS name,
        ARRAY(
          SELECT trim(y.v) FROM (
            SELECT ce.phone AS v, 0 AS o
            UNION ALL
            SELECT cm.value, 1 FROM lead_contact_methods cm
            WHERE ce.attribution_status = 'attributed' AND cm.lead_id = ce.matched_lead_id AND cm.channel = 'phone'
          ) y
          WHERE y.v IS NOT NULL AND trim(y.v) <> ''
          ORDER BY y.o
        ) AS phones,
        ce.received_at AS at,
        ce.event AS type,
        NULL::jsonb AS payload
      FROM conversion_events ce
      LEFT JOIN leads l ON l.id = ce.matched_lead_id AND ce.attribution_status = 'attributed'
      WHERE ce.org_id = ${q.orgId}
        AND ce.brand_id = ${q.brandId}
        AND ce.event = ANY(${sql.param([...evidence.ledgerEvents])}::text[])
        ${evidence.ledgerSources ? sql`AND ce.source = ANY(${sql.param([...evidence.ledgerSources])}::text[])` : sql``}
        AND ce.withdrawn_at IS NULL
        ${email === null ? sql`AND ce.received_at >= ${q.since}::timestamptz` : sql``}
    ) r
    WHERE cardinality(r.emails) > 0
      ${email === null ? sql`` : sql`AND ${email} = ANY(r.emails)`}
  `)) as unknown as RawReachRow[];

  // A booked meeting whose time passed with no cancel / no-show was held (meeting-held.ts): the same reach the
  // outcome trigger fires on.
  const heldRows: ReachRow[] = [];
  if (q.step === MEETING_HELD_STEP) {
    const now = new Date();
    const since = q.since === undefined ? null : Date.parse(q.since);
    const scope = sql`f.org_id = ${q.orgId} AND f.brand_id = ${q.brandId}`;
    const held = await readHeldMeetings({
      where: email === null ? scope : sql`${scope} AND ${crmFactHasEmail("f", email)}`,
      startsFrom: since === null ? new Date(0) : new Date(since - HELD_MEETING_START_LOOKBACK_MS),
      startsTo: new Date(now.getTime() - HELD_GRACE_MS),
      now,
    });
    for (const m of held) {
      if (since !== null && Date.parse(m.heldAt) < since) continue;
      heldRows.push({ emails: m.emails, name: m.name, phones: m.phones, at: m.heldAt, type: "meeting_held", payload: null });
    }
  }

  const people = groupReachedPeople([...crmRows.map(toReachRow), ...ledgerRows.map(toReachRow), ...heldRows], email);
  await fillNamesAndPhones(q.orgId, q.brandId, people);
  return people;
}

/**
 * A visit fact rarely carries a name or a phone; the person's other facts at the brand (a signup, a payment, a
 * message) often do. Fills ONLY what is missing, from the latest live fact of the brand naming the address.
 */
async function fillNamesAndPhones(orgId: string, brandId: string, people: ReachedPerson[]): Promise<void> {
  const missing = people.filter((p) => p.name === null || p.phone === null).map((p) => p.email);
  if (missing.length === 0) return;
  // ONE pass over the brand's copy (never one scan per person), newest first; the first answer per address wins.
  const rows = (await db.execute(sql`
    SELECT lower(trim(e)) AS email, NULLIF(trim(f.full_name), '') AS name, f.phones
    FROM crm_facts f, unnest(f.emails) AS e
    WHERE f.org_id = ${orgId}
      AND f.brand_id = ${brandId}
      AND lower(trim(e)) = ANY(${sql.param(missing)}::text[])
      AND (NULLIF(trim(f.full_name), '') IS NOT NULL OR cardinality(f.phones) > 0)
      AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id)
    ORDER BY f.occurred_at DESC NULLS LAST, f.seq DESC
  `)) as unknown as Array<{ email: string; name: string | null; phones: string[] | null }>;
  const known = new Map<string, { name: string | null; phone: string | null }>();
  for (const r of rows) {
    const k = known.get(r.email) ?? { name: null, phone: null };
    if (k.name === null && r.name) k.name = r.name;
    if (k.phone === null) k.phone = (r.phones ?? []).map((x) => x.trim()).find(Boolean) ?? null;
    known.set(r.email, k);
  }
  for (const p of people) {
    const found = known.get(p.email);
    if (!found) continue;
    if (p.name === null) p.name = found.name;
    if (p.phone === null) p.phone = found.phone;
  }
}
