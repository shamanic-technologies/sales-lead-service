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
 *                                          evidence, and any human ruling
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
import { matchConversion, type MatchResult } from "../lib/conversions.js";
import {
  addCrmPairingCounts,
  resolveCrmPairing,
  needsJudgment,
  zeroCrmPairingCounts,
  CRM_JUDGMENT_PAIR_AT,
  CRM_JUDGMENT_REJECT_AT,
  CRM_STAGE_UNCOMPARABLE_REASON,
  type CrmJudgmentUnavailableReason,
  type CrmPairingJudgment,
  type CrmPairingRulingKind,
} from "../lib/crm-pairing.js";
import {
  countLeadsNoCrmContactPointsAt,
  freezeMatches,
  loadFrozenMatches,
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
import { fetchPairedLeadFacts, resolveStandingsForLeads } from "../lib/crm-pairing-view.js";
import { createLeadStandingResolver } from "../lib/lead-standing-resolver.js";
import { watchClient, isClientGone } from "../lib/client-abort.js";

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

/** How many waterfalls run at once while walking their CRM. Each is a handful of indexed probes. */
const MATCH_CONCURRENCY = 8;

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

/** The matcher's input, built from THEIR contact. Nothing is invented — an absent field stays absent. */
function waterfallInputFor(brandId: string, contact: CrmContact) {
  return {
    brandId,
    email: contact.primaryEmail,
    phone: contact.phoneE164,
    firstName: contact.firstName,
    lastName: contact.lastName,
    // Their company reaches the domain tier only as a URL/domain. A company NAME is not a domain
    // and is never coerced into one — it goes to the judgment, which is where a name is useful.
    companyUrl: contact.companyUrl ?? null,
  };
}

/** Run `fn` over `items` with at most `limit` in flight, preserving input order in the output. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The frozen match for every contact on this page, matching (and freezing) whatever had none.
 *
 * A contact already matched is NEVER re-matched — that is what makes a second read of the view
 * return the same pairings.
 */
async function matchesForContacts(
  orgId: string,
  brandId: string,
  contacts: CrmContact[],
): Promise<Map<string, FrozenMatch>> {
  const ids = contacts.map((c) => c.id);
  const frozen = await loadFrozenMatches(brandId, ids);
  const missing = contacts.filter((c) => !frozen.has(c.id));
  if (missing.length === 0) return frozen;

  const results = await mapWithConcurrency(
    missing,
    MATCH_CONCURRENCY,
    async (contact): Promise<{ crmContactId: string; result: MatchResult }> => ({
      crmContactId: contact.id,
      result: await matchConversion(waterfallInputFor(brandId, contact)),
    }),
  );
  const written = await freezeMatches(orgId, brandId, results);
  for (const [id, match] of written) frozen.set(id, match);
  return frozen;
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

    const orgId = req.orgId!;
    const identity = {
      orgId,
      userId: req.userId ?? null,
      runId: req.runId ?? null,
      brandId,
    };

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

      const contactIds = contacts.map((c) => c.id);
      const [matches, opportunitiesByContact] = await Promise.all([
        matchesForContacts(orgId, brandId, contacts),
        fetchCrmOpportunitiesByContact(brandId, identity),
      ]);

      const [judgments, rulings] = await Promise.all([
        loadJudgments(brandId, contactIds),
        loadRulings(brandId, contactIds),
      ]);

      // Our half, for the leads this page actually paired with — never the brand's population.
      const leadIds = Array.from(
        new Set(
          contacts
            .map((c) => matches.get(c.id)?.matchedLeadId)
            .filter((id): id is string => !!id),
        ),
      );
      const leadFacts = await fetchPairedLeadFacts(brandId, leadIds);

      // Judge only what the deterministic signals could not decide, that nobody has ruled on and
      // that carries no frozen judgment already. Bounded, and every failure degrades to a stated
      // reason rather than to a merge or a rejection.
      const toJudge = contacts
        .filter((contact) => {
          const match = matches.get(contact.id);
          if (!match?.matchedLeadId) return false;
          if (!needsJudgment(match)) return false;
          if (judgments.has(contact.id)) return false;
          if (rulings.has(rulingKey(contact.id, match.matchedLeadId))) return false;
          return leadFacts.has(match.matchedLeadId);
        })
        .slice(0, MAX_JUDGMENTS_PER_READ);

      const judgmentFailures = new Map<string, CrmJudgmentUnavailableReason>();
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

      // Where each paired lead stands, resolved the same way every other surface resolves it.
      const standings = await resolveStandingsForLeads(
        brandId,
        Array.from(leadFacts.values()),
        createLeadStandingResolver({
          orgId,
          userId: req.userId ?? null,
          runId: req.runId ?? null,
          brandId,
          deliveryQueried: true,
        }),
        getServiceContext(req),
      );

      const pairings = contacts.map((contact) => {
        const match = matches.get(contact.id) ?? {
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

        return {
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
          ourStanding: lead ? (standings.get(lead.leadId) ?? null) : null,
          theirStatus: serializeOpportunities(opportunitiesByContact.get(contact.id) ?? []),
        };
      });

      return res.json({
        crmConnected: true,
        connection,
        pairings,
        nextOffset: contacts.length === limit ? offset + contacts.length : null,
        judgmentThresholds: { pairAt: CRM_JUDGMENT_PAIR_AT, rejectAt: CRM_JUDGMENT_REJECT_AT },
      });
    } catch (error) {
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
