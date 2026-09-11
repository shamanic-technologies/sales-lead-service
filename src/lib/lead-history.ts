/**
 * WHAT HAPPENED TO THIS PERSON, in order — the assembly behind `GET /orgs/leads/:id/history`.
 *
 * A customer opening a lead asks one question, and until this existed nobody answered it: the
 * dashboard fetched six services in the BROWSER, de-duplicated them there, sorted them by
 * timestamp there, and decided what to hide there. So there was no source of truth for what
 * happened to a person, and every consumer invented one — which is why a reply we hold showed as
 * a bare "they replied" with no words, why follow-ups kept reading as scheduled after the
 * sequence had stopped, and why an exchange living in the owner's own mailbox was invisible.
 *
 * This module is PURE: it takes what each owner answered and produces one ordered list. The route
 * does the IO. Four things are load-bearing.
 *
 * (1) **NOTHING IS RE-DERIVED.** Every fact is asked of the service that owns it — the delivery
 *     evidence from email-gateway, the messages and the recorded reply statements from
 *     instantly-service, the customer's own mailbox from google-service, the copy we produced from
 *     content-generation-service, and this service's own funnel statements, conversions, lifecycle
 *     and follow-up state. No funnel logic and no outcome logic lives here; a step statement is
 *     carried as the statement it is, never re-implied. This is an ORDERING, not a second brain.
 *
 * (2) **ASSERTED IS NOT OBSERVED, AND THE ANSWER SAYS WHICH.** `evidence: "observed"` is a fact we
 *     hold — a message whose words we can produce, a delivery milestone the provider measured, a
 *     conversion the tracker reported. `evidence: "asserted"` is a fact somebody stated — a
 *     recorded reply, a recorded opt-out, a hand-stated funnel step. And within replies the two
 *     kinds stay apart by TYPE, not by a flag a consumer has to remember: a reply we can produce
 *     the words of is a `message`, a reply somebody wrote down because it never reached us is a
 *     `reply_statement` and carries no body — because there are no words to carry.
 *
 * (3) **THE ANSWER SAYS WHAT IT COULD NOT READ.** Every source is listed with its own status. A
 *     source that could not answer degrades ITSELF (`status: "unavailable"` + the reason) and sets
 *     `complete: false`; it never empties the list and never takes the read down. "We could not
 *     read this" and "this did not happen" are different facts, and collapsing them would tell a
 *     customer their prospect said nothing.
 *
 * (4) **THE DE-DUPLICATION THE BROWSER WAS DOING HAPPENS HERE.** A send whose words we hold is one
 *     event, not a message plus a "sent" milestone; not the copy we DRAFTED beside the message
 *     that actually went out; and the same thread mirrored on both the outreach side and the
 *     customer's mailbox is one message, not two. What a consumer receives is already merged —
 *     that is the whole point of moving it. The drafted copy is still stated for a person nothing
 *     has been sent to yet, because there it is the only thing we have.
 *
 * (5) **A LINK IN A MESSAGE SAYS WHERE IT ACTUALLY LEADS.** The sending side strips our tracking
 *     parameters from the visible text and swaps the destination for the provider's click-tracking
 *     redirect, so the body we hold carries neither. Each link therefore names what the prospect
 *     SAW and, resolved against the copy we generated, where it truly goes — see
 *     `message-links.ts`. The redirect is never a destination: following one from a dashboard
 *     would register a click the prospect never made.
 */
import type { FlattenedStatus } from "./delivery-flatten.js";
import type { GeneratedEmail } from "./generated-email-client.js";
import type { MailboxConversation } from "./mailbox-client.js";
import { LinkDestinationIndex, resolveMessageLinks, type MessageLink } from "./message-links.js";
import type {
  OutreachConversation,
  OutreachOptOut,
  OutreachReplyStatement,
  SourceRead,
} from "./outreach-client.js";

// ─── Sources ───

export const HISTORY_SOURCES = [
  "lead-service",
  "delivery",
  "outreach",
  "mailbox",
  "content",
] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];

export type HistorySourceStatus = "ok" | "unavailable" | "not_asked";

export interface HistorySourceState {
  source: HistorySource;
  status: HistorySourceStatus;
  /** Why it could not answer, or why it was not asked. Null when it answered. */
  reason: string | null;
}

// ─── Events ───

export type HistoryEvidence = "observed" | "asserted";

export type HistoryEventType =
  | "generated_email"
  | "message"
  | "delivery"
  | "lifecycle"
  | "reply_statement"
  | "opt_out_statement"
  | "step_statement"
  | "conversion"
  | "followup";

export interface HistoryEventBase {
  /** Stable within one response — a consumer can key a list on it. */
  id: string;
  /** ISO 8601 UTC, or null when the fact carries no date. Null sorts LAST, never as the epoch. */
  at: string | null;
  type: HistoryEventType;
  evidence: HistoryEvidence;
  source: HistorySource;
  /** The campaign this happened on, when the fact belongs to one. A tracker-reported conversion
   * knows the brand and nothing about which campaign reached the person, so it is null there. */
  campaignId: string | null;
  direction: "inbound" | "outbound" | null;
}

export interface HistoryMessageEvent extends HistoryEventBase {
  type: "message";
  from: string | null;
  to: string[];
  subject: string | null;
  /** The words. Null only when the holder says it could not read them — see `bodyStatus`. */
  bodyText: string | null;
  /** ok: these are the words. empty: it genuinely says nothing. unavailable: we hold the message
   * and could not read it, which is NOT the same as it being empty. */
  bodyStatus: "ok" | "empty" | "unavailable";
  threadId: string | null;
  /** Which copy this message was read from, and which OTHER copies also hold it. A message
   * mirrored on both sides is one event that names both. */
  heldBy: HistorySource[];
  /** `mirror` is the copy that outlives the outreach provider's subscription. */
  copy: string | null;
  /** The links in this message: what the prospect SAW, and where each truly leads. The visible
   * text is what the sending side left in the body (our tracking parameters stripped from it);
   * the destination is resolved against the copy we generated, so it carries those parameters
   * back. Null `href` when it cannot be resolved — never the provider's click-tracking redirect,
   * and never a guess. */
  links: MessageLink[];
}

export interface HistoryDeliveryEvent extends HistoryEventBase {
  type: "delivery";
  milestone: "sent" | "delivered" | "opened" | "clicked" | "replied" | "bounced" | "unsubscribed";
}

export interface HistoryLifecycleEvent extends HistoryEventBase {
  type: "lifecycle";
  milestone: "served" | "handed_to_sending";
}

export interface HistoryGeneratedEmailEvent extends HistoryEventBase {
  type: "generated_email";
  subject: string | null;
  /** The words. Null whenever the producer handed none over — see `bodyStatus`, which says
   * WHICH of the two absences this is. */
  bodyText: string | null;
  /** Same three-way answer the `message` event carries, and for the same reason. ok: these are
   * the words. empty: the producer handed over a body and it genuinely says nothing.
   * unavailable: a generation exists — we wrote to this person — and its producer served no
   * body we could read, so the words are missing rather than absent. Silence about that is what
   * made a lead panel render a date and nothing else, with no sentence explaining why. The words
   * are NEVER recovered from the planned sequence here: the producer owns what we wrote. */
  bodyStatus: "ok" | "empty" | "unavailable";
  /** The cadence the sequence PLANNED, verbatim from its producer. It is a plan, not a promise —
   * what is still owed is the `followup` event, which reads this service's live state. */
  plannedSequence: unknown;
  model: string | null;
}

export interface HistoryReplyStatementEvent extends HistoryEventBase {
  type: "reply_statement";
  replyKind: string;
  statedBy: string | null;
  note: string | null;
}

export interface HistoryOptOutStatementEvent extends HistoryEventBase {
  type: "opt_out_statement";
  channel: string;
  statedBy: string | null;
  note: string | null;
}

export interface HistoryStepStatementEvent extends HistoryEventBase {
  type: "step_statement";
  step: string;
  kind: "outcome" | "never";
  valueCents: number | null;
  costCents: number | null;
  statedBy: string | null;
  note: string | null;
}

export interface HistoryConversionEvent extends HistoryEventBase {
  type: "conversion";
  event: string;
  valueCents: number | null;
  matchConfidence: string | null;
  attributionStatus: string | null;
}

export interface HistoryFollowupEvent extends HistoryEventBase {
  type: "followup";
  state: "scheduled" | "stopped";
  /** When the next answer is owed. Null on a stopped schedule — a stopped sequence never
   * advertises a next follow-up, which is the bug this replaces. */
  dueAt: string | null;
  followupCount: number;
  stoppedReason: string | null;
}

export type HistoryEvent =
  | HistoryMessageEvent
  | HistoryDeliveryEvent
  | HistoryLifecycleEvent
  | HistoryGeneratedEmailEvent
  | HistoryReplyStatementEvent
  | HistoryOptOutStatementEvent
  | HistoryStepStatementEvent
  | HistoryConversionEvent
  | HistoryFollowupEvent;

// ─── Input ───

export interface HistoryCampaignInput {
  leadCampaignId: string;
  campaignId: string;
  status: string;
  createdAt: string | null;
  servedAt: string | null;
  sentAt: string | null;
  followupDueAt: string | null;
  followupCount: number;
  followupLastActionAt: string | null;
  followupStoppedReason: string | null;
  /** The delivery evidence for THIS campaign, already flattened. Null when it was not asked for
   * (an unserved row, or a lead with no registered email). */
  delivery: FlattenedStatus | null;
  conversation: SourceRead<OutreachConversation | null>;
  generation: SourceRead<GeneratedEmail | null>;
}

export interface HistoryStatedOutcome {
  id: string;
  step: string;
  campaignId: string | null;
  at: string | null;
  valueCents: number | null;
  costCents: number | null;
  statedByUserId: string | null;
  note: string | null;
}

export interface HistoryStatedNever {
  id: string;
  step: string;
  campaignId: string | null;
  at: string | null;
  costCents: number | null;
  statedByUserId: string | null;
  note: string | null;
}

export interface HistoryTrackerConversion {
  id: string;
  event: string;
  at: string | null;
  valueCents: number | null;
  matchConfidence: string | null;
  attributionStatus: string | null;
}

export interface AssembleHistoryInput {
  email: string | null;
  campaigns: HistoryCampaignInput[];
  /** Whether the delivery layer answered at all, and why not when it did not. */
  deliveryRead: SourceRead<null>;
  mailbox: SourceRead<MailboxConversation | null>;
  replyStatements: SourceRead<OutreachReplyStatement[]>;
  optOuts: SourceRead<OutreachOptOut[]>;
  /** This service's own statements and conversions, already filtered to what still STANDS —
   * withdrawn and retracted rows are excluded upstream, exactly as every other read here does. */
  statedOutcomes: HistoryStatedOutcome[];
  statedNevers: HistoryStatedNever[];
  trackerConversions: HistoryTrackerConversion[];
}

export interface AssembledHistory {
  events: HistoryEvent[];
  sources: HistorySourceState[];
  /** False when ANY source could not answer. A consumer must never read this list as the whole
   * story while something is missing. */
  complete: boolean;
}

// ─── Assembly ───

/** Order among events that share a timestamp: the thing that caused comes before the thing caused. */
const TYPE_RANK: Record<HistoryEventType, number> = {
  lifecycle: 0,
  generated_email: 1,
  message: 2,
  delivery: 3,
  reply_statement: 4,
  opt_out_statement: 5,
  conversion: 6,
  step_statement: 7,
  followup: 8,
};

function normalizeSubject(subject: string | null): string {
  return (subject ?? "")
    .toLowerCase()
    .replace(/^((re|fwd|fw)\s*:\s*)+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The minute is the resolution two mirrors of one message agree on; the second is not. */
function minuteKey(at: string | null): string {
  if (!at) return "";
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return at;
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

function messageKey(
  direction: string,
  at: string | null,
  subject: string | null,
  body: string | null,
): string {
  const bodyHead = (body ?? "").replace(/\s+/g, " ").trim().slice(0, 120).toLowerCase();
  return `${direction}|${minuteKey(at)}|${normalizeSubject(subject)}|${bodyHead}`;
}

function pushDelivery(
  events: HistoryEvent[],
  campaignId: string,
  milestone: HistoryDeliveryEvent["milestone"],
  at: string | null,
  direction: "inbound" | "outbound" | null,
): void {
  if (!at) return;
  events.push({
    id: `delivery:${campaignId}:${milestone}`,
    at,
    type: "delivery",
    evidence: "observed",
    source: "delivery",
    campaignId,
    direction,
    milestone,
  });
}

/**
 * Why a generated email has no words, told apart the same way the `message` event tells them
 * apart. A generation row EXISTS because we wrote to this person, so a body the producer never
 * handed over is a body we could not read — `unavailable` — and not the email saying nothing.
 * An empty string is the producer answering, and that answer is `empty`. Nothing here reads the
 * planned sequence: recovering the copy is the producer's job, not this service's.
 */
function generatedBodyStatus(bodyText: string | null): "ok" | "empty" | "unavailable" {
  if (bodyText === null || bodyText === undefined) return "unavailable";
  return bodyText.trim().length > 0 ? "ok" : "empty";
}

export function assembleLeadHistory(input: AssembleHistoryInput): AssembledHistory {
  const events: HistoryEvent[] = [];
  const sources = new Map<HistorySource, HistorySourceState>();

  const noteSource = (
    source: HistorySource,
    status: HistorySourceStatus,
    reason: string | null,
  ): void => {
    const existing = sources.get(source);
    // Across several campaigns one source can answer for some and fail for others: the failure is
    // what a consumer must know about, so it wins.
    if (existing && existing.status === "unavailable") return;
    if (existing && status === "ok") return;
    sources.set(source, { source, status, reason });
  };

  noteSource("lead-service", "ok", null);

  // ── Where the links in a message actually lead ──
  //
  // The sending side strips our tracking parameters from a link's visible text and replaces its
  // destination with the provider's own click-tracking redirect, so the body we hold carries
  // neither. The copy we generated carries the same URL WITH its parameters, so the destinations
  // are indexed off it and nothing new is fetched. A link matching no URL we wrote resolves to
  // null; the redirect is unreachable here because it appears in no generated copy.
  const destinations = new LinkDestinationIndex();
  for (const campaign of input.campaigns) {
    if (!campaign.generation.ok) continue;
    const generation = campaign.generation.data;
    if (!generation) continue;
    destinations.add(generation.bodyText);
    destinations.add(generation.bodyHtml);
    // The follow-ups of the sequence carry their own copy, and a message we hold may be one of
    // them. The shape is the producer's, so it is scanned as text rather than walked as a schema.
    if (generation.sequence != null) {
      try {
        destinations.add(JSON.stringify(generation.sequence));
      } catch {
        // A sequence that cannot be serialized simply contributes no destinations.
      }
    }
  }

  // ── The messages, from both holders, de-duplicated ──
  //
  // The outreach copy is preferred when both hold a message: it is campaign-attributable and the
  // mirror is what survives the provider's plan ending. The mailbox copy is what makes an exchange
  // that never touched the sequence visible at all.
  const byKey = new Map<string, HistoryMessageEvent>();

  for (const campaign of input.campaigns) {
    if (!campaign.conversation.ok) {
      noteSource("outreach", "unavailable", campaign.conversation.reason);
      continue;
    }
    noteSource("outreach", "ok", null);
    const conversation = campaign.conversation.data;
    if (!conversation) continue;

    for (const [index, message] of conversation.messages.entries()) {
      const key = messageKey(message.direction, message.at, message.subject, message.text);
      const event: HistoryMessageEvent = {
        id: `message:outreach:${campaign.campaignId}:${index}`,
        at: message.at || null,
        type: "message",
        evidence: "observed",
        source: "outreach",
        campaignId: campaign.campaignId,
        direction: message.direction,
        from: message.from || null,
        to: message.to ? [message.to] : [],
        subject: message.subject || null,
        bodyText: message.text ?? null,
        bodyStatus: message.text && message.text.length > 0 ? "ok" : "empty",
        threadId: null,
        heldBy: ["outreach"],
        copy: conversation.source ?? null,
        links: resolveMessageLinks(message.text ?? null, destinations),
      };
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.heldBy.includes("outreach")) existing.heldBy.push("outreach");
        continue;
      }
      byKey.set(key, event);
    }
  }

  if (!input.mailbox.ok) {
    noteSource("mailbox", "unavailable", input.mailbox.reason);
  } else {
    noteSource("mailbox", "ok", null);
    const conversation = input.mailbox.data;
    if (conversation) {
      for (const thread of conversation.threads) {
        for (const message of thread.messages) {
          const direction = message.direction === "other" ? null : message.direction;
          const body = message.bodyText ?? message.snippet ?? null;
          const key = messageKey(message.direction, message.sentAt, message.subject, body);
          const existing = byKey.get(key);
          if (existing) {
            if (!existing.heldBy.includes("mailbox")) existing.heldBy.push("mailbox");
            continue;
          }
          byKey.set(key, {
            id: `message:mailbox:${message.gmailMessageId}`,
            at: message.sentAt,
            type: "message",
            evidence: "observed",
            source: "mailbox",
            // The mailbox knows an address, not a campaign. Claiming one would be a guess.
            campaignId: null,
            direction,
            from: message.fromEmail,
            to: message.to ?? [],
            subject: message.subject,
            bodyText: message.bodyStatus === "unavailable" ? null : body,
            bodyStatus: message.bodyStatus,
            threadId: message.threadId,
            heldBy: ["mailbox"],
            copy: "gmail_mirror",
            links: resolveMessageLinks(
              message.bodyStatus === "unavailable" ? null : body,
              destinations,
            ),
          });
        }
      }
      // A mirror that holds the exchange and cannot read it is stated, never rendered as silence.
      if (conversation.status !== "ok") {
        noteSource(
          "mailbox",
          "unavailable",
          `the Gmail mirror answered status=${conversation.status} for this address`,
        );
      }
    }
  }

  const messageEvents = [...byKey.values()];
  events.push(...messageEvents);

  const hasOutbound = new Set<string>();
  const hasInbound = new Set<string>();
  for (const message of messageEvents) {
    if (!message.campaignId) continue;
    if (message.direction === "outbound") hasOutbound.add(message.campaignId);
    if (message.direction === "inbound") hasInbound.add(message.campaignId);
  }

  // ── Per campaign: what we produced, what the delivery layer measured, the lifecycle, the debt ──
  for (const campaign of input.campaigns) {
    if (!campaign.generation.ok) {
      noteSource("content", "unavailable", campaign.generation.reason);
    } else {
      noteSource("content", "ok", null);
      const generation = campaign.generation.data;
      // The copy we DRAFTED is stated only while it is the only thing we have. Once we hold the
      // message that actually went out, that message IS the event: the two are the same email —
      // hours or a day apart, worded differently (the draft carries no signature and no
      // unsubscribe line) and with the link written differently in each — so stating both showed
      // one email twice and left the reader unable to tell which one was real. A person still
      // sitting in the sending queue has no message yet, and there the draft is all there is.
      if (generation && !hasOutbound.has(campaign.campaignId)) {
        events.push({
          id: `generated_email:${generation.id}`,
          at: generation.createdAt,
          type: "generated_email",
          evidence: "observed",
          source: "content",
          campaignId: campaign.campaignId,
          direction: "outbound",
          subject: generation.subject,
          bodyText: generation.bodyText,
          bodyStatus: generatedBodyStatus(generation.bodyText),
          plannedSequence: generation.sequence,
          model: generation.model,
        });
      }
    }

    if (campaign.servedAt) {
      events.push({
        id: `lifecycle:${campaign.leadCampaignId}:served`,
        at: campaign.servedAt,
        type: "lifecycle",
        evidence: "observed",
        source: "lead-service",
        campaignId: campaign.campaignId,
        direction: null,
        milestone: "served",
      });
    }
    if (campaign.sentAt) {
      events.push({
        id: `lifecycle:${campaign.leadCampaignId}:handed_to_sending`,
        at: campaign.sentAt,
        type: "lifecycle",
        evidence: "observed",
        source: "lead-service",
        campaignId: campaign.campaignId,
        direction: null,
        milestone: "handed_to_sending",
      });
    }

    const delivery = campaign.delivery;
    if (delivery) {
      // A send whose WORDS we hold is one event, not a message plus a milestone saying the same
      // thing at the same moment; likewise a reply. The milestones that no message can carry —
      // opened, clicked, bounced, unsubscribed — are always emitted.
      if (!hasOutbound.has(campaign.campaignId)) {
        pushDelivery(events, campaign.campaignId, "sent", delivery.firstSentAt, "outbound");
      }
      pushDelivery(events, campaign.campaignId, "delivered", delivery.firstDeliveredAt, "outbound");
      pushDelivery(events, campaign.campaignId, "opened", delivery.firstOpenedAt, "inbound");
      pushDelivery(events, campaign.campaignId, "clicked", delivery.firstClickedAt, "inbound");
      if (!hasInbound.has(campaign.campaignId)) {
        pushDelivery(events, campaign.campaignId, "replied", delivery.firstRepliedAt, "inbound");
      }
      pushDelivery(events, campaign.campaignId, "bounced", delivery.firstBouncedAt, "inbound");
      pushDelivery(
        events,
        campaign.campaignId,
        "unsubscribed",
        delivery.firstUnsubscribedAt,
        "inbound",
      );
    }

    // What we owe this person NEXT, read from live state. A stopped schedule states that it is
    // stopped and carries no due date — a stopped sequence must never advertise a next follow-up.
    if (campaign.followupStoppedReason) {
      events.push({
        id: `followup:${campaign.leadCampaignId}:stopped`,
        at: campaign.followupLastActionAt,
        type: "followup",
        evidence: "observed",
        source: "lead-service",
        campaignId: campaign.campaignId,
        direction: null,
        state: "stopped",
        dueAt: null,
        followupCount: campaign.followupCount,
        stoppedReason: campaign.followupStoppedReason,
      });
    } else if (campaign.followupDueAt) {
      events.push({
        id: `followup:${campaign.leadCampaignId}:scheduled`,
        at: campaign.followupLastActionAt ?? campaign.followupDueAt,
        type: "followup",
        evidence: "observed",
        source: "lead-service",
        campaignId: campaign.campaignId,
        direction: null,
        state: "scheduled",
        dueAt: campaign.followupDueAt,
        followupCount: campaign.followupCount,
        stoppedReason: null,
      });
    }
  }

  if (input.deliveryRead.ok) {
    // Only claim the delivery layer answered when it was actually asked — an unserved lead, or one
    // with no registered email, is not evidence about delivery either way.
    const asked = input.campaigns.some((c) => c.delivery !== null);
    noteSource("delivery", asked ? "ok" : "not_asked", asked ? null : "no served row in this scope");
  } else {
    noteSource("delivery", "unavailable", input.deliveryRead.reason);
  }

  // ── What a human recorded on the outreach side ──
  if (!input.replyStatements.ok) {
    noteSource("outreach", "unavailable", input.replyStatements.reason);
  } else {
    noteSource("outreach", "ok", null);
    const campaignIds = new Set(input.campaigns.map((c) => c.campaignId));
    for (const statement of input.replyStatements.data) {
      if (statement.withdrawnAt) continue;
      if (!campaignIds.has(statement.campaignId)) continue;
      events.push({
        id: `reply_statement:${statement.id}`,
        at: statement.qualifiedAt,
        type: "reply_statement",
        evidence: "asserted",
        source: "outreach",
        campaignId: statement.campaignId,
        direction: "inbound",
        replyKind: statement.replyKind ?? statement.status,
        statedBy: statement.qualifiedBy ?? null,
        note: statement.notes ?? null,
      });
    }
  }

  if (!input.optOuts.ok) {
    noteSource("outreach", "unavailable", input.optOuts.reason);
  } else {
    noteSource("outreach", "ok", null);
    for (const optOut of input.optOuts.data) {
      if (optOut.withdrawnAt) continue;
      events.push({
        id: `opt_out_statement:${optOut.id}`,
        at: optOut.statedAt,
        type: "opt_out_statement",
        evidence: "asserted",
        // An opt-out is the person's own act, recorded by a human; it belongs to the person, not
        // to a campaign.
        source: "outreach",
        campaignId: null,
        direction: "inbound",
        channel: optOut.channel,
        statedBy: optOut.statedBy ?? null,
        note: optOut.notes ?? null,
      });
    }
  }

  // ── This service's own statements and the tracker's own reports ──
  for (const outcome of input.statedOutcomes) {
    events.push({
      id: `step_statement:outcome:${outcome.id}`,
      at: outcome.at,
      type: "step_statement",
      evidence: "asserted",
      source: "lead-service",
      campaignId: outcome.campaignId,
      direction: null,
      step: outcome.step,
      kind: "outcome",
      valueCents: outcome.valueCents,
      costCents: outcome.costCents,
      statedBy: outcome.statedByUserId,
      note: outcome.note,
    });
  }
  for (const never of input.statedNevers) {
    events.push({
      id: `step_statement:never:${never.id}`,
      at: never.at,
      type: "step_statement",
      evidence: "asserted",
      source: "lead-service",
      campaignId: never.campaignId,
      direction: null,
      step: never.step,
      kind: "never",
      valueCents: null,
      costCents: never.costCents,
      statedBy: never.statedByUserId,
      note: never.note,
    });
  }
  for (const conversion of input.trackerConversions) {
    events.push({
      id: `conversion:${conversion.id}`,
      at: conversion.at,
      type: "conversion",
      evidence: "observed",
      source: "lead-service",
      campaignId: null,
      direction: null,
      event: conversion.event,
      valueCents: conversion.valueCents,
      matchConfidence: conversion.matchConfidence,
      attributionStatus: conversion.attributionStatus,
    });
  }

  events.sort((a, b) => {
    if (a.at === null && b.at !== null) return 1;
    if (b.at === null && a.at !== null) return -1;
    if (a.at !== null && b.at !== null && a.at !== b.at) return a.at < b.at ? -1 : 1;
    const rank = TYPE_RANK[a.type] - TYPE_RANK[b.type];
    if (rank !== 0) return rank;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  for (const source of HISTORY_SOURCES) {
    if (!sources.has(source)) {
      sources.set(source, { source, status: "not_asked", reason: "nothing in scope to ask about" });
    }
  }

  const ordered = HISTORY_SOURCES.map((source) => sources.get(source)!);

  return {
    events,
    sources: ordered,
    complete: ordered.every((s) => s.status !== "unavailable"),
  };
}
