import { describe, expect, it } from "vitest";
import { groupReachedPeople, refuseStep, STEP_REACHED_STEPS } from "../../src/lib/step-reached.js";

const row = (emails: string[], at: string | null, over: Record<string, unknown> = {}) => ({
  emails,
  name: null,
  phones: [],
  at,
  type: "signup",
  payload: null,
  ...over,
});

describe("step-reached rules", () => {
  it("answers the catalogue steps it sees and refuses the rest by name", () => {
    expect(STEP_REACHED_STEPS).toEqual(["website_visit", "signup", "form_submitted", "meeting_booked", "meeting_attended", "paid_client"]);
    for (const s of STEP_REACHED_STEPS) expect(refuseStep(s)).toBeNull();
    expect(refuseStep("conversation")?.code).toBe("step_not_observable");
    expect(refuseStep("sale")?.code).toBe("unknown_step");
  });

  it("rows sharing any address are ONE person, named by the first address of their earliest reach", () => {
    const people = groupReachedPeople([
      row(["B@x.com", "a@x.com"], "2026-10-14T10:00:00.000Z", { name: "Old" }),
      row(["a@x.com"], "2026-10-14T09:00:00.000Z"),
      row(["c@x.com", "b@x.com"], "2026-10-14T11:00:00.000Z", { name: "New", phones: ["+1"] }),
      row(["d@x.com"], null),
      row([], "2026-10-14T08:00:00.000Z"),
    ]);
    expect(people).toEqual([
      { email: "a@x.com", name: "New", phone: "+1", reachedAt: "2026-10-14T09:00:00.000Z" },
      { email: "d@x.com", name: null, phone: null, reachedAt: null },
    ]);
  });

  it("a payment reaches only when it stands; email mode names the asked address", () => {
    const people = groupReachedPeople(
      [
        row(["a@x.com", "b@x.com"], "2026-10-14T10:00:00.000Z", { type: "payment", payload: { status: "succeeded", amountMinor: 10, amountRefunded: 0 } }),
        row(["c@x.com"], "2026-10-14T10:00:00.000Z", { type: "payment", payload: { status: "failed", amountMinor: 10 } }),
      ],
      "b@x.com",
    );
    expect(people).toEqual([{ email: "b@x.com", name: null, phone: null, reachedAt: "2026-10-14T10:00:00.000Z" }]);
  });
});
