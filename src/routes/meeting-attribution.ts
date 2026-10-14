import { Router } from "express";
import { z } from "zod";
import { apiKeyAuth } from "../middleware/auth.js";
import { MeetingAttributionUnavailableError, readMeetingAttribution } from "../lib/meeting-attribution.js";
import { readMeetingBookingBeforeAfter } from "../lib/meeting-booking-before-after.js";

const router = Router();

const Query = z.object({
  brandId: z.string().min(1).optional(),
  since: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "since must be an ISO date")
    .optional(),
});

/**
 * GET /internal/meeting-attribution[?brandId=&since=] — who booked each meeting (our AI Meeting
 * Booking or the client's own team) and the Positive reply -> Meeting booked rate per side, with the
 * people each rate is based on; fleet-wide, per brand in `byBrand`, or one brand
 * (src/lib/meeting-attribution.ts). 502 when campaign-service cannot name a side (never a guess).
 */
router.get("/internal/meeting-attribution", apiKeyAuth, async (req, res) => {
  const parsed = Query.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query", detail: parsed.error.issues });
    return;
  }
  try {
    const result = await readMeetingAttribution({
      brandId: parsed.data.brandId ?? null,
      since: parsed.data.since ? new Date(parsed.data.since).toISOString() : null,
    });
    res.json({
      scope: { brandId: parsed.data.brandId ?? null, since: parsed.data.since ? new Date(parsed.data.since).toISOString() : null },
      legKey: "conversation_to_meeting_booked",
      ...result,
    });
  } catch (error) {
    if (error instanceof MeetingAttributionUnavailableError) {
      console.error(`[lead-service] meeting attribution unavailable: ${error.message}`);
      res.status(502).json({ error: "meeting_attribution_unavailable", detail: error.message });
      return;
    }
    console.error("[lead-service] meeting attribution read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const BeforeAfterQuery = z.object({ brandId: z.string().min(1).optional() });

/**
 * GET /internal/meeting-attribution/before-after[?brandId=] — per brand that turned AI Meeting
 * Booking on, the Positive reply -> Meeting booked rate before its go-live (first AI Meeting Booking
 * act) and after, each with its people, plus a fleet roll-up (src/lib/meeting-booking-before-after.ts).
 */
router.get("/internal/meeting-attribution/before-after", apiKeyAuth, async (req, res) => {
  const parsed = BeforeAfterQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query", detail: parsed.error.issues });
    return;
  }
  try {
    const result = await readMeetingBookingBeforeAfter({ brandId: parsed.data.brandId ?? null });
    res.json({ scope: { brandId: parsed.data.brandId ?? null }, legKey: "conversation_to_meeting_booked", ...result });
  } catch (error) {
    if (error instanceof MeetingAttributionUnavailableError) {
      console.error(`[lead-service] meeting booking before/after unavailable: ${error.message}`);
      res.status(502).json({ error: "meeting_attribution_unavailable", detail: error.message });
      return;
    }
    console.error("[lead-service] meeting booking before/after read failed:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
