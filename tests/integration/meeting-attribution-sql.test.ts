/**
 * Meeting attribution against a REAL database: the four answer sources (follow-up ledger, outreach
 * `reply_sent` current per subject, Gmail answers Jev judged, answered-outside statements), the
 * positive replies (timeline + CRM) and the meetings are one set of raw statements a mocked `sql`
 * compiles none of. campaign-service is the only thing mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const ORG = randomUUID();
const BRAND = randomUUID();
const OFFER = randomUUID();

vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async () =>
    new Response(
      JSON.stringify({
        campaigns: [
          { id: "itest-ai-mb", brandIds: [BRAND], offerId: OFFER, legKey: "conversation_to_meeting_booked", featureSlug: "ai-meeting-booking", status: "ongoing" },
          { id: "itest-team", brandIds: [BRAND], offerId: OFFER, legKey: "conversation_to_meeting_booked", featureSlug: "your-team-meeting-booking", status: "ongoing" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
}));

const { sql } = await import("../../src/db/index.js");
const { readMeetingAttribution } = await import("../../src/lib/meeting-attribution.js");
const { readMeetingBookingBeforeAfter } = await import("../../src/lib/meeting-booking-before-after.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("meeting attribution against a real database", () => {
  const tag = randomUUID().slice(0, 8);
  const lead: Record<string, string> = {};
  const email = (n: string) => `${n}-${tag}@example.test`;
  let seq = BigInt(Date.now()) * 1000n;

  async function seedLead(name: string): Promise<string> {
    const [row] = (await sql`INSERT INTO leads (first_name) VALUES (${name}) RETURNING id::text AS id`) as unknown as Array<{ id: string }>;
    await sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${row.id}::uuid, 'email', ${email(name)}, 'itest')`;
    lead[name] = row.id;
    return row.id;
  }

  async function positiveReply(name: string, at: string): Promise<void> {
    const id = `reply:itest:${tag}:${name}:${at}`;
    await sql`
      INSERT INTO lead_timeline_facts (id, org_id, brand_id, offer_id, lead_id, campaign_id, occurred_at, label, source, source_ref, detail)
      VALUES (${id}, ${ORG}, ${BRAND}, ${OFFER}, ${lead[name]}::uuid, 'itest-outreach', ${at}::timestamptz, 'interested', 'reply', ${id},
              ${JSON.stringify({ classification: "positive" })}::jsonb)
    `;
  }

  async function meeting(name: string | null, at: string, status = "attributed"): Promise<string> {
    const [row] = (await sql`
      INSERT INTO conversion_events (org_id, brand_id, event, source, email, matched_lead_id, match_confidence, attribution_status, received_at)
      VALUES (${ORG}, ${BRAND}, 'meeting_booked', 'crm', ${name ? email(name) : `nobody-${tag}@example.test`},
              ${name ? lead[name] : null}::uuid, ${name ? "deterministic" : "unmatched"}, ${status}, ${at}::timestamptz)
      RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;
    return row.id;
  }

  async function replySent(name: string, at: string, sentBy: string, subject = randomUUID()): Promise<string> {
    seq += 1n;
    await sql`
      INSERT INTO outreach_facts (seq, subject_key, type, occurred_at, lead_email, org_id, campaign_id, brand_ids, raw)
      VALUES (${seq.toString()}::bigint, ${subject}, 'reply_sent', ${at}::timestamptz, ${email(name).toUpperCase()}, ${ORG}, 'itest-outreach',
              ${sql.array([BRAND])}::text[], ${JSON.stringify({ replySent: { sentBy, via: "replies_route" } })}::jsonb)
    `;
    return subject;
  }

  async function withdraw(subject: string, name: string): Promise<void> {
    seq += 1n;
    await sql`
      INSERT INTO outreach_facts (seq, subject_key, type, occurred_at, lead_email, org_id, brand_ids, raw)
      VALUES (${seq.toString()}::bigint, ${subject}, 'withdrawn', now(), ${email(name)}, ${ORG}, ${sql.array([BRAND])}::text[], '{}'::jsonb)
    `;
  }

  const ids: Record<string, string> = {};

  beforeAll(async () => {
    for (const n of ["ai", "team", "gmail", "stated", "withdrawn", "unhandled"]) await seedLead(n);
    for (const n of Object.keys(lead)) await positiveReply(n, "2026-10-01T10:00:00Z");

    // AI Meeting Booking acted (ledger) + its automation reply_sent seconds before.
    await sql`
      INSERT INTO followup_actions (org_id, brand_ids, lead_campaign_id, lead_id, held_by_campaign_id, acting_campaign_id, action, occurred_at, source)
      VALUES (${ORG}, ${sql.array([BRAND])}::text[], gen_random_uuid(), ${lead.ai}::uuid, 'itest-outreach', 'itest-ai-mb', 'acted', '2026-10-01T11:00:10Z', 'live')
    `;
    await replySent("ai", "2026-10-01T11:00:00Z", "automation");
    ids.ai = await meeting("ai", "2026-10-03T10:00:00Z");

    await replySent("team", "2026-10-01T12:00:00Z", "human");
    ids.team = await meeting("team", "2026-10-03T10:00:00Z");

    await sql`
      INSERT INTO outside_answer_judgments (org_id, brand_id, lead_id, gmail_message_id, mailbox, sent_at, answers, probability, model)
      VALUES (${ORG}, ${BRAND}, ${lead.gmail}::uuid, ${`g-${tag}`}, 'org', '2026-10-01T12:00:00Z', true, 0.9, 'itest'),
             (${ORG}, ${BRAND}, ${lead.gmail}::uuid, ${`g2-${tag}`}, 'org', '2026-10-02T12:00:00Z', false, 0.1, 'itest')
    `;
    ids.gmail = await meeting("gmail", "2026-10-03T10:00:00Z");

    await sql`INSERT INTO answered_outside_statements (org_id, brand_id, lead_id, stated_at) VALUES (${ORG}, ${BRAND}, ${lead.stated}::uuid, '2026-10-01T12:00:00Z')`;

    const subject = await replySent("withdrawn", "2026-10-01T12:00:00Z", "human");
    await withdraw(subject, "withdrawn");
    ids.withdrawn = await meeting("withdrawn", "2026-10-03T10:00:00Z");

    ids.nobody = await meeting(null, "2026-10-03T10:00:00Z", "unmatched");
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  it("ties each meeting to its person and to what booked it", async () => {
    const r = await readMeetingAttribution({ brandId: BRAND, since: null });
    const byId = new Map(r.attributedMeetings.map((m) => [m.conversionEventId, m]));
    expect(byId.get(ids.ai)).toMatchObject({ leadId: lead.ai, arm: "aiMeetingBooking", bookedBy: { campaignId: "itest-ai-mb", answerVia: "followup_ledger" } });
    expect(byId.get(ids.team)).toMatchObject({ arm: "yourTeamMeetingBooking", bookedBy: { kind: "person", campaignId: "itest-team", answerVia: "reply_sent" } });
    expect(byId.get(ids.gmail)).toMatchObject({ arm: "yourTeamMeetingBooking", bookedBy: { answerVia: "gmail_answer" } });
    expect(byId.get(ids.withdrawn)).toMatchObject({ arm: "unknown", unknownReason: "no_answer_before_meeting" });
    expect(byId.get(ids.nobody)).toMatchObject({ leadId: null, arm: "unknown", unknownReason: "person_unknown" });
  });

  it("answers both sides with their populations", async () => {
    const r = await readMeetingAttribution({ brandId: BRAND, since: null });
    expect(r.summary.positiveReplyPeople).toBe(6);
    expect(r.summary.arms.aiMeetingBooking).toEqual({ handled: 1, booked: 1, rate: 1 });
    // team + gmail booked; stated answered, never booked.
    expect(r.summary.arms.yourTeamMeetingBooking).toEqual({ handled: 3, booked: 2, rate: 2 / 3 });
    expect(r.summary.unhandled).toEqual({ people: 2, booked: 1 });
    expect(r.summary.meetings).toMatchObject({ total: 5, aiMeetingBooking: 1, yourTeamMeetingBooking: 2, unknown: 2 });
  });

  it("splits the brand at its first AI Meeting Booking act, every positive replier in one window", async () => {
    const r = await readMeetingBookingBeforeAfter({ brandId: BRAND });
    expect(r.brands).toHaveLength(1);
    const b = r.brands[0];
    expect(b.goLive).toMatchObject({ at: "2026-10-01T11:00:10.000Z", basis: "first_ai_meeting_booking_act", campaignId: "itest-ai-mb" });
    expect(b.before.people + b.after.people).toBe(6);
    expect(b.before).toMatchObject({ people: 6, booked: 4, bookedAfterGoLive: 4 });
    expect(b.after).toMatchObject({ people: 0, booked: 0, rate: null });
    expect(b.unplacedMeetings).toEqual({ count: 1, reasons: { person_unknown: 1 } });
    expect(r.fleet.brands).toBe(1);
  });
});
