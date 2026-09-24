/**
 * WHICH PEOPLE IN THE CUSTOMER'S OWN CRM ARE LEADS WE EMAILED.
 *
 * A customer runs their own CRM and we mirror it. Their CRM already knows things about people we
 * contacted that we do not: measured on the first mirrored account, three of our cold-emailed
 * leads sit there as closed deals and eight more have a booked or attended meeting, while this
 * service holds exactly one hand-stated outcome for that brand, on a different lead. Nothing put
 * the two sides in front of a human, so none of it was ever reconciled.
 *
 * Four routes, all additive, all brand-scoped:
 *
 *   GET    /orgs/leads/crm-pairings        one row per CRM contact: both sides, the pairing's own
 *                                          evidence, any human ruling, and where their record came
 *                                          from; `?state=` narrows to a set of pairing states
 *   GET    /orgs/leads/crm-pairing-counts  the summary — what pairs, what does not, and how many of
 *                                          our leads their CRM has never heard of
 *   POST   /orgs/leads/crm-pairings/rulings     a human accepts or denies a pairing
 *   DELETE /orgs/leads/crm-pairings/rulings     a human takes that statement back
 *
 * Registered BEFORE `/orgs/leads/:id` (see src/index.ts) so the literal paths win over the
 * parameter, exactly as `/orgs/leads/bucket-counts` and `/orgs/leads/standing-counts` already do.
 * The two GETs are reachable through the gateway with no gateway change for the same reason.
 *
 * WHAT THIS DOES NOT DO. It never writes to their CRM (no service in this fleet has a write path
 * into one). It never maps their pipeline stage names onto any step vocabulary of ours — those
 * names are free text chosen per customer, there is no canonical mapping, and guessing one
 * produces a confident wrong answer, so a stage is served with its own "this means nothing we can
 * compare" reason attached. It never holds a brand's whole lead population. And it changes nothing
 * about what the conversion-attribution path does with the matcher they share.
 */
import { Router } from "express";
import {
  type AuthenticatedRequest,
  apiKeyAuth,
  requireOrgId,
  getServiceContext,
} from "../middleware/auth.js";
import {
  addCrmPairingCounts,
  resolveCrmPairing,
  needsJudgment,
  zeroCrmPairingCounts,
  CRM_JUDGMENT_PAIR_AT,
  CRM_JUDGMENT_REJECT_AT,
  CRM_PAIRING_STATES,
  CRM_STAGE_UNCOMPARABLE_REASON,
  type CrmJudgmentUnavailableReason,
  type CrmPairingJudgment,
  type CrmPairingRuling,
  type CrmPairingRulingKind,
  type CrmPairingState,
  type CrmPairingVerdict,
} from "../lib/crm-pairing.js";
import {
  countLeadsNoCrmContactPointsAt,
  loadJudgments,
  loadRulings,
  rulingKey,
  saveJudgment,
  upsertRuling,
  withdrawRuling,
  type FrozenMatch,
} from "../lib/crm-pairing-store.js";
import {
  CrmServiceError,
  fetchCrmConnection,
  fetchCrmContactsPage,
  fetchCrmOpportunitiesByContact,
  streamCrmContacts,
  type CrmContact,
  type CrmOpportunity,
} from "../lib/crm-client.js";
import { JudgmentUnavailableError, judgeSamePerson } from "../lib/judgment-client.js";
import {
  fetchPairedLeadFacts,
  resolveStandingsForLeads,
  type PairedLeadFacts,
} from "../lib/crm-pairing-view.js";
import { createLeadStandingResolver } from "../lib/lead-standing-resolver.js";
import { watchClient, isClientGone } from "../lib/client-abort.js";
import { mapWithConcurrency, matchesForContacts } from "../lib/crm-matching.js";

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Page defaults. A debug table reads a screenful; the cap keeps one read's judgment spend bounded. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

/**
 * How many pairings one read will pay a judgment for. A judgment is asked once per pairing and
 * then frozen, so this bounds a first read rather than steady-state cost; beyond it the remaining
 * rows read `not_asked` and are judged on the next page-through, which is honest and cheap.
 */
const MAX_JUDGMENTS_PER_READ = 100;

/** Judgments in flight at once. Bounded so one read cannot stampede chat-service. */
const JUDGMENT_CONCURRENCY = 6;


// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function parseBrandId(raw: unknown): string | null {
  return typeof raw === "string" && UUID_RE.test(raw) ? raw : null;
}

function parseBound(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) return null;
  return n;
}

function parseOffset(raw: unknown): number | null {
  if (raw === undefined) return 0;
  if (typeof raw !== "string") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}

function serializeOpportunities(opportunities: CrmOpportunity[]) {
  return {
    opportunities: opportunities.map((o) => ({
      id: o.id,
      externalId: o.externalId,
      name: o.name,
      state: o.state,
      stateRaw: o.stateRaw,
      monetaryValue: o.monetaryValue,
      pipelineName: o.pipelineName,
      stageName: o.stageName,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    })),
    // Their status is a SET, not a value: one real person on the first mirrored account is at once
    // a closed-won deal, a free-trial client and a past event attendee.
    states: Array.from(new Set(opportunities.map((o) => o.state).filter((s): s is NonNullable<typeof s> => !!s))),
    /** Always false. See CRM_STAGE_UNCOMPARABLE_REASON — there is no canonical mapping to invent. */
    stageNamesComparable: false as const,
    stageComparabilityReason: CRM_STAGE_UNCOMPARABLE_REASON,
  };
}

// ---------------------------------------------------------------------------
// GET /orgs/leads/crm-pairings
// ---------------------------------------------------------------------------

/** How many of their contacts a filtered read resolves at a time while walking their list. */
const FILTER_WALK_CHUNK = 100;

/**
 * `?state=paired,unconfirmed` — a comma-separated SET of pairing states, read as one set (the same
 * shape `?status=` and `?standing=` take on the leads list). `undefined` when absent; `null` when
 * unparseable, which is a 400: a silently-ignored filter would render an unfiltered list that
 * looks filtered.
 */
function parseStateFilter(raw: unknown): Set<CrmPairingState> | undefined | null {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return null;
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const out = new Set<CrmPairingState>();
  for (const part of parts) {
    if (!(CRM_PAIRING_STATES as readonly string[]).includes(part)) return null;
    out.add(part as CrmPairingState);
  }
  return out;
}

interface ReadContext {
  orgId: string;
  brandId: string;
  identity: { orgId: string; userId: string | null; runId: string | null; brandId: string };
}

/** Everything the policy needs about one contact, resolved. */
interface ResolvedContact {
  contact: CrmContact;
  match: FrozenMatch;
  lead: PairedLeadFacts | null;
  judgment: CrmPairingJudgment | null;
  ruling: CrmPairingRuling | null;
  verdict: CrmPairingVerdict;
}

/**
 * Resolve a batch of their contacts: freeze any missing match, read the frozen judgments and
 * rulings, buy the judgments this batch still lacks (only when `judge` is set, and never beyond
 * the read's shared `budget`), and decide each pairing.
 *
 * Both the unfiltered page and a filtered walk go through this, so a row is decided the same way
 * whichever read serves it — and the same way `/crm-pairing-counts` decides it, since every
 * judgment bought here is frozen before the verdict is read.
 */
async function resolveContacts(
  ctx: ReadContext,
  contacts: CrmContact[],
  opts: { judge: boolean; budget: { remaining: number } },
): Promise<ResolvedContact[]> {
  const { orgId, brandId, identity } = ctx;
  const contactIds = contacts.map((c) => c.id);
  const matches = await matchesForContacts(orgId, brandId, contacts);
  const [judgments, rulings] = await Promise.all([
    loadJudgments(brandId, contactIds),
    loadRulings(brandId, contactIds),
  ]);

  // Our half, for the leads this batch actually paired with — never the brand's population.
  const leadIds = Array.from(
    new Set(
      contacts.map((c) => matches.get(c.id)?.matchedLeadId).filter((id): id is string => !!id),
    ),
  );
  const leadFacts = await fetchPairedLeadFacts(brandId, leadIds);

  // Judge only what the deterministic signals could not decide, that nobody has ruled on and
  // that carries no frozen judgment already. Bounded, and every failure degrades to a stated
  // reason rather than to a merge or a rejection.
  const judgmentFailures = new Map<string, CrmJudgmentUnavailableReason>();
  if (opts.judge && opts.budget.remaining > 0) {
    const toJudge = contacts
      .filter((contact) => {
        const match = matches.get(contact.id);
        if (!match?.matchedLeadId) return false;
        if (!needsJudgment(match)) return false;
        if (judgments.has(contact.id)) return false;
        if (rulings.has(rulingKey(contact.id, match.matchedLeadId))) return false;
        return leadFacts.has(match.matchedLeadId);
      })
      .slice(0, opts.budget.remaining);
    opts.budget.remaining -= toJudge.length;

    await mapWithConcurrency(toJudge, JUDGMENT_CONCURRENCY, async (contact) => {
      const match = matches.get(contact.id)!;
      const lead = leadFacts.get(match.matchedLeadId!)!;
      try {
        const judgment = await judgeSamePerson(
          {
            crmContact: {
              fullName: contact.fullName,
              firstName: contact.firstName,
              lastName: contact.lastName,
              email: contact.primaryEmail,
              phone: contact.phoneE164,
              company: contact.companyName ?? null,
            },
            ourLead: {
              fullName: lead.fullName,
              firstName: lead.firstName,
              lastName: lead.lastName,
              email: lead.email,
              jobTitle: lead.jobTitle,
              company: lead.company,
              companyDomain: lead.companyDomain,
              location: lead.location,
            },
          },
          identity,
        );
        await saveJudgment({
          orgId,
          brandId,
          crmContactId: contact.id,
          leadId: lead.leadId,
          samePersonProbability: judgment.probability,
          model: judgment.model,
        });
        judgments.set(contact.id, {
          leadId: lead.leadId,
          samePersonProbability: judgment.probability,
          model: judgment.model,
          judgedAt: new Date().toISOString(),
        });
      } catch (error) {
        if (!(error instanceof JudgmentUnavailableError)) throw error;
        console.warn(
          `[crm-pairings] no judgment for contact="${contact.id}" lead="${lead.leadId}", so the ` +
            `pairing stays unconfirmed: ${error.message}`,
        );
        judgmentFailures.set(contact.id, error.reason);
      }
    });
  }

  return contacts.map((contact) => {
    const match: FrozenMatch = matches.get(contact.id) ?? {
      crmContactId: contact.id,
      matchedLeadId: null,
      matchMethod: null,
      matchConfidence: "unmatched" as const,
      candidateCount: 0,
      matchedAt: null,
    };
    const lead = match.matchedLeadId ? (leadFacts.get(match.matchedLeadId) ?? null) : null;
    const stored = judgments.get(contact.id) ?? null;
    // A judgment frozen against a DIFFERENT lead than the one this pairing now names says
    // nothing about this pairing, so it is not read as if it did.
    const judgment: CrmPairingJudgment | null =
      stored && stored.leadId === match.matchedLeadId
        ? {
            samePersonProbability: stored.samePersonProbability,
            model: stored.model,
            judgedAt: stored.judgedAt,
          }
        : null;
    const ruling = match.matchedLeadId
      ? (rulings.get(rulingKey(contact.id, match.matchedLeadId)) ?? null)
      : null;
    const verdict = resolveCrmPairing({
      signal: match,
      judgment,
      judgmentUnavailableReason: judgmentFailures.get(contact.id) ?? null,
      ruling,
    });
    return { contact, match, lead, judgment, ruling, verdict };
  });
}

/** Their contact's provenance, verbatim. Every field `null` when their CRM holds none. */
function serializeRecord(contact: CrmContact) {
  const r = contact.record;
  return {
    type: r?.type ?? null,
    leadSource: r?.leadSource ?? null,
    tags: r?.tags ?? null,
    createdAt: r?.createdAt ?? null,
    updatedAt: r?.updatedAt ?? null,
    origin: {
      medium: r?.origin.medium ?? null,
      url: r?.origin.url ?? null,
      referrer: r?.origin.referrer ?? null,
    },
  };
}

/** The served rows, with where each paired lead stands resolved the way every other surface does. */
async function serializePairings(
  req: AuthenticatedRequest,
  ctx: ReadContext,
  rows: ResolvedContact[],
  opportunitiesByContact: Map<string, CrmOpportunity[]>,
) {
  const leads = Array.from(
    new Map(rows.filter((r) => r.lead).map((r) => [r.lead!.leadId, r.lead!])).values(),
  );
  const standings = await resolveStandingsForLeads(
    ctx.brandId,
    leads,
    createLeadStandingResolver({
      orgId: ctx.orgId,
      userId: req.userId ?? null,
      runId: req.runId ?? null,
      brandId: ctx.brandId,
      deliveryQueried: true,
    }),
    getServiceContext(req),
  );

  return rows.map(({ contact, match, lead, judgment, ruling, verdict }) => ({
    crmContact: {
      id: contact.id,
      externalId: contact.externalId,
      fullName: contact.fullName,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.primaryEmail,
      phone: contact.phoneE164,
      company: contact.companyName ?? null,
      unsubscribed: contact.unsubscribed,
      record: serializeRecord(contact),
    },
    pairing: {
      state: verdict.state,
      decidedBy: verdict.decidedBy,
      lead: lead
        ? {
            leadId: lead.leadId,
            leadCampaignId: lead.leadCampaignId,
            campaignId: lead.campaignId,
            fullName: lead.fullName,
            email: lead.email,
            jobTitle: lead.jobTitle,
            company: lead.company,
          }
        : null,
      evidence: {
        matchMethod: match.matchMethod,
        matchConfidence: match.matchConfidence,
        candidateCount: match.candidateCount,
        matchedAt: match.matchedAt,
      },
      judgment: {
        status: verdict.judgmentStatus,
        unavailableReason: verdict.judgmentUnavailableReason,
        samePersonProbability: judgment?.samePersonProbability ?? null,
        model: judgment?.model ?? null,
        judgedAt: judgment?.judgedAt ?? null,
      },
      ruling,
    },
    ourStanding: lead ? (standings.get(lead.leadId)?.standing ?? null) : null,
    // The deal on our lead, off the SAME resolution the standing came from — including what their
    // own CRM evidences for a paired lead, so the two sides of this row can finally agree.
    ...(lead ? { ourClosedDeal: standings.get(lead.leadId)?.closedDeal ?? null } : {}),
    theirStatus: serializeOpportunities(opportunitiesByContact.get(contact.id) ?? []),
  }));
}

/**
 * A filtered read: walk THEIR contact list from `offset`, a chunk at a time, keeping only the
 * contacts whose pairing is in `states`, until `limit` are held — so no read holds more than a
 * page of rows, whatever the size of their CRM.
 *
 * `offset` and `nextOffset` are POSITIONS IN THEIR CONTACT LIST, exactly as on the unfiltered
 * read: `nextOffset` is the position of the first matching contact beyond this page (null when
 * none remains). A position rather than an ordinal among matches, because a person confirming or
 * denying a row moves it OUT of the set they were paging — an ordinal would then skip whoever
 * slid into its place, and the rows a person is working through are exactly the ones they rule on.
 *
 * Judgments are bought only when the filter includes `unconfirmed`: that is the only state a
 * judgment can move a row out of, so a read that does not ask for it must not spend on rows it
 * will never serve. Rows are decided AFTER any judgment this read bought is frozen, which is what
 * keeps a filtered page and `/crm-pairing-counts` answering for the same set.
 */
async function walkFiltered(
  req: AuthenticatedRequest,
  res: import("express").Response,
  ctx: ReadContext,
  states: Set<CrmPairingState>,
  limit: number,
  offset: number,
): Promise<{ rows: ResolvedContact[]; nextOffset: number | null }> {
  const client = watchClient(req, res);
  const budget = { remaining: MAX_JUDGMENTS_PER_READ };
  const judge = states.has("unconfirmed");
  const rows: ResolvedContact[] = [];
  let position = offset;
  try {
    for await (const page of streamCrmContacts(ctx.brandId, ctx.identity, offset)) {
      for (let i = 0; i < page.length; i += FILTER_WALK_CHUNK) {
        client.stopIfGone(position - offset);
        const chunk = page.slice(i, i + FILTER_WALK_CHUNK);
        const resolved = await resolveContacts(ctx, chunk, { judge, budget });
        for (const row of resolved) {
          if (states.has(row.verdict.state)) {
            if (rows.length === limit) return { rows, nextOffset: position };
            rows.push(row);
          }
          position += 1;
        }
      }
    }
    return { rows, nextOffset: null };
  } finally {
    client.dispose();
  }
}

router.get(
  "/orgs/leads/crm-pairings",
  apiKeyAuth,
  requireOrgId,
  async (req: AuthenticatedRequest, res) => {
    const brandId = parseBrandId(req.query.brandId);
    if (!brandId) {
      return res.status(400).json({ error: "brandId is required and must be a uuid" });
    }
    const limit = parseBound(req.query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    if (limit === null) {
      return res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_PAGE_SIZE}` });
    }
    const offset = parseOffset(req.query.offset);
    if (offset === null) {
      return res.status(400).json({ error: "offset must be an integer of 0 or more" });
    }
    const states = parseStateFilter(req.query.state);
    if (states === null) {
      return res.status(400).json({
        error: `state must be a comma-separated list of ${CRM_PAIRING_STATES.join(", ")}`,
      });
    }

    const orgId = req.orgId!;
    const identity = {
      orgId,
      userId: req.userId ?? null,
      runId: req.runId ?? null,
      brandId,
    };
    const ctx: ReadContext = { orgId, brandId, identity };

    try {
      // A brand with no mirrored CRM is an ANSWER, not an error — the surface renders an empty
      // table and says why.
      const connection = await fetchCrmConnection(brandId, identity);
      if (!connection) {
        return res.json({
          crmConnected: false,
          connection: null,
          pairings: [],
          nextOffset: null,
          judgmentThresholds: { pairAt: CRM_JUDGMENT_PAIR_AT, rejectAt: CRM_JUDGMENT_REJECT_AT },
        });
      }

      let rows: ResolvedContact[];
      let nextOffset: number | null;
      let opportunitiesByContact: Map<string, CrmOpportunity[]>;

      if (states) {
        [{ rows, nextOffset }, opportunitiesByContact] = await Promise.all([
          walkFiltered(req, res, ctx, states, limit, offset),
          fetchCrmOpportunitiesByContact(brandId, identity),
        ]);
      } else {
        const contacts = await fetchCrmContactsPage(brandId, limit, offset, identity);
        if (contacts.length === 0) {
          return res.json({
            crmConnected: true,
            connection,
            pairings: [],
            nextOffset: null,
            judgmentThresholds: { pairAt: CRM_JUDGMENT_PAIR_AT, rejectAt: CRM_JUDGMENT_REJECT_AT },
          });
        }
        [rows, opportunitiesByContact] = await Promise.all([
          resolveContacts(ctx, contacts, {
            judge: true,
            budget: { remaining: MAX_JUDGMENTS_PER_READ },
          }),
          fetchCrmOpportunitiesByContact(brandId, identity),
        ]);
        nextOffset = contacts.length === limit ? offset + contacts.length : null;
      }

      const pairings = await serializePairings(req, ctx, rows, opportunitiesByContact);

      return res.json({
        crmConnected: true,
        connection,
        pairings,
        nextOffset,
        judgmentThresholds: { pairAt: CRM_JUDGMENT_PAIR_AT, rejectAt: CRM_JUDGMENT_REJECT_AT },
      });
    } catch (error) {
      if (isClientGone(error)) {
        console.warn("[crm-pairings] the caller stopped reading a filtered page before it finished");
        res.destroy();
        return;
      }
      if (error instanceof CrmServiceError) {
        console.error(`[crm-pairings] their CRM could not be read: ${error.message}`);
        return res.status(502).json({ error: "crm-service unavailable" });
      }
      console.error("[crm-pairings] list error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /orgs/leads/crm-pairing-counts
// ---------------------------------------------------------------------------

/**
 * The summary a consumer puts above the table.
 *
 * Their whole contact population is WALKED, a page at a time, and folded into counters — nothing
 * accumulates a list, so this costs the same heap on a CRM of any size. It never asks for a
 * judgment and never spends: it reports what the stored state already says, so a summary can be
 * polled without buying anything.
 */
router.get(
  "/orgs/leads/crm-pairing-counts",
  apiKeyAuth,
  requireOrgId,
  async (req: AuthenticatedRequest, res) => {
    const brandId = parseBrandId(req.query.brandId);
    if (!brandId) {
      return res.status(400).json({ error: "brandId is required and must be a uuid" });
    }

    const orgId = req.orgId!;
    const identity = { orgId, userId: req.userId ?? null, runId: req.runId ?? null, brandId };
    const client = watchClient(req, res);

    try {
      const connection = await fetchCrmConnection(brandId, identity);
      if (!connection) {
        return res.json({
          crmConnected: false,
          counts: zeroCrmPairingCounts(),
          ourLeadsNoCrmContactPointsAt: 0,
        });
      }

      const opportunitiesByContact = await fetchCrmOpportunitiesByContact(brandId, identity);
      const counts = zeroCrmPairingCounts();

      let walked = 0;
      for await (const page of streamCrmContacts(brandId, identity)) {
        client.stopIfGone(walked);
        walked += page.length;

        const matches = await matchesForContacts(orgId, brandId, page);
        const contactIds = page.map((c) => c.id);
        const [judgments, rulings] = await Promise.all([
          loadJudgments(brandId, contactIds),
          loadRulings(brandId, contactIds),
        ]);

        for (const contact of page) {
          const match = matches.get(contact.id);
          const signal = match ?? {
            matchedLeadId: null,
            matchMethod: null,
            matchConfidence: "unmatched" as const,
            candidateCount: 0,
          };
          const stored = judgments.get(contact.id) ?? null;
          const judgment =
            stored && stored.leadId === signal.matchedLeadId
              ? {
                  samePersonProbability: stored.samePersonProbability,
                  model: stored.model,
                  judgedAt: stored.judgedAt,
                }
              : null;
          const ruling = signal.matchedLeadId
            ? (rulings.get(rulingKey(contact.id, signal.matchedLeadId)) ?? null)
            : null;
          const verdict = resolveCrmPairing({
            signal,
            judgment,
            judgmentUnavailableReason: null,
            ruling,
          });

          const opportunities = opportunitiesByContact.get(contact.id) ?? [];
          addCrmPairingCounts(counts, {
            hasEmail: !!contact.primaryEmail,
            state: verdict.state,
            matchMethod: signal.matchMethod,
            opportunityStates: opportunities.map((o) => o.state),
            opportunityStageNames: opportunities.map((o) => o.stageName),
          });
        }
      }

      return res.json({
        crmConnected: true,
        counts,
        ourLeadsNoCrmContactPointsAt: await countLeadsNoCrmContactPointsAt(brandId),
      });
    } catch (error) {
      if (isClientGone(error)) {
        console.warn("[crm-pairings] the caller stopped reading the summary before it finished");
        res.destroy();
        return;
      }
      if (error instanceof CrmServiceError) {
        console.error(`[crm-pairings] their CRM could not be read: ${error.message}`);
        return res.status(502).json({ error: "crm-service unavailable" });
      }
      console.error("[crm-pairings] counts error:", error);
      return res.status(500).json({ error: "Internal server error" });
    } finally {
      client.dispose();
    }
  },
);

// ---------------------------------------------------------------------------
// POST /orgs/leads/crm-pairings/rulings
// ---------------------------------------------------------------------------

const RULING_KINDS: readonly CrmPairingRulingKind[] = ["accepted", "rejected"];

/**
 * A human accepts or denies a pairing. Outranks the signal and the judgment alike, survives a
 * re-run of the matcher (the statement is keyed on the pair, not on a matcher run), and is
 * correctable by restating or withdrawing.
 */
router.post(
  "/orgs/leads/crm-pairings/rulings",
  apiKeyAuth,
  requireOrgId,
  async (req: AuthenticatedRequest, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const brandId = parseBrandId(body.brandId);
    if (!brandId) {
      return res.status(400).json({ error: "brandId is required and must be a uuid" });
    }
    const crmContactId = typeof body.crmContactId === "string" ? body.crmContactId.trim() : "";
    if (!crmContactId) {
      return res.status(400).json({ error: "crmContactId is required" });
    }
    const leadId = typeof body.leadId === "string" && UUID_RE.test(body.leadId) ? body.leadId : null;
    if (!leadId) {
      return res.status(400).json({ error: "leadId is required and must be a uuid" });
    }
    const ruling = body.ruling;
    if (typeof ruling !== "string" || !RULING_KINDS.includes(ruling as CrmPairingRulingKind)) {
      return res.status(400).json({ error: `ruling must be one of ${RULING_KINDS.join(", ")}` });
    }
    const note =
      body.note === undefined || body.note === null
        ? null
        : typeof body.note === "string"
          ? body.note
          : undefined;
    if (note === undefined) {
      return res.status(400).json({ error: "note must be a string when present" });
    }

    try {
      await upsertRuling({
        orgId: req.orgId!,
        brandId,
        crmContactId,
        leadId,
        ruling: ruling as CrmPairingRulingKind,
        note,
        statedByUserId: req.userId ?? null,
      });
      return res.status(201).json({
        ruling: {
          brandId,
          crmContactId,
          leadId,
          ruling,
          note,
          statedByUserId: req.userId ?? null,
        },
      });
    } catch (error) {
      console.error("[crm-pairings] ruling write error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// DELETE /orgs/leads/crm-pairings/rulings
// ---------------------------------------------------------------------------

/**
 * A human takes their statement back. NOTHING IS DELETED — the row survives carrying both what was
 * stated and the fact that it was withdrawn, and the pairing falls back to whatever the judgment
 * and the signal say. Idempotent.
 */
router.delete(
  "/orgs/leads/crm-pairings/rulings",
  apiKeyAuth,
  requireOrgId,
  async (req: AuthenticatedRequest, res) => {
    const brandId = parseBrandId(req.query.brandId);
    if (!brandId) {
      return res.status(400).json({ error: "brandId is required and must be a uuid" });
    }
    const crmContactId =
      typeof req.query.crmContactId === "string" ? req.query.crmContactId.trim() : "";
    if (!crmContactId) {
      return res.status(400).json({ error: "crmContactId is required" });
    }
    const leadId =
      typeof req.query.leadId === "string" && UUID_RE.test(req.query.leadId)
        ? req.query.leadId
        : null;
    if (!leadId) {
      return res.status(400).json({ error: "leadId is required and must be a uuid" });
    }

    try {
      const result = await withdrawRuling({
        brandId,
        crmContactId,
        leadId,
        withdrawnByUserId: req.userId ?? null,
      });
      if (!result.existed) {
        return res.status(409).json({
          code: "nothing_stated",
          error: "nobody has ruled on this pairing, so there is nothing to withdraw",
        });
      }
      return res.json({
        withdrawn: true,
        alreadyWithdrawn: result.alreadyWithdrawn,
        brandId,
        crmContactId,
        leadId,
      });
    } catch (error) {
      console.error("[crm-pairings] ruling withdrawal error:", error);
      return res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
