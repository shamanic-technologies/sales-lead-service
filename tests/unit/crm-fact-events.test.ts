import { describe, it, expect } from "vitest";

// A funnel FACT is a funnel EVENT under other field names. This pins the mapping the prod parity
// probe proved (1,691 vs 1,691): step = type, source = payload.via, sourceId = sourceRef, detail =
// the payload under funnel-events names, one entry per crm contact row.

const { funnelEventFromFact, contactsFromFactRows } = await import("../../src/lib/crm-fact-events.js");

function row(over: Record<string, unknown> = {}) {
  return {
    crm_contact_id: "c-1",
    emails: ["ann@example.com", "ann@work.example"],
    full_name: "Ann Example",
    type: "meeting_booked",
    occurred_at: "2026-04-08 22:56:29+00",
    date_basis: "booked_at",
    source_ref: "appt-1",
    payload: { via: "appointment", startsAt: "2026-04-10T18:00:00.000Z", calendarName: "Demo", formId: null },
    ...over,
  };
}

describe("a funnel fact read as a funnel event", () => {
  it("maps every field the evidence sync reads", () => {
    expect(funnelEventFromFact(row())).toEqual({
      step: "meeting_booked",
      occurredAt: "2026-04-08T22:56:29.000Z",
      dateBasis: "booked_at",
      source: "appointment",
      sourceId: "appt-1",
      detail: { calendarName: "Demo", formId: null, scheduledStart: "2026-04-10T18:00:00.000Z" },
    });
  });

  it("keeps an undated fact undated", () => {
    expect(funnelEventFromFact(row({ occurred_at: null })).occurredAt).toBeNull();
  });

  it("groups per crm contact row, first email first, events in feed order", () => {
    const contacts = contactsFromFactRows([
      row(),
      row({ crm_contact_id: "c-2", emails: [], type: "sale", source_ref: "opp-1" }),
      row({ type: "meeting_attended", source_ref: "appt-1b" }),
    ]);
    expect(contacts.map((c) => [c.contactId, c.primaryEmail, c.events.map((e) => e.step)])).toEqual([
      ["c-1", "ann@example.com", ["meeting_booked", "meeting_attended"]],
      ["c-2", null, ["sale"]],
    ]);
  });
});
