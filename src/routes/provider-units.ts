/**
 * Provider reads of our Units (ENGINE-GET-ASK-1123): `GET /orgs/units/<outcome>`, one per outcome this service
 * declares on runs-service's ledger. workflow-service finds each by its OpenAPI tag `provider:<outcome key>` and calls
 * it as a script's run. Semantics: lib/provider-units.ts; vocabulary and parsing: lib/provider-units-query.ts.
 *
 * Reads only: nothing is served, claimed, bought or written, and no other service is called. Scoped to `x-org-id`.
 * They answer on the `general` HTTP thread (request-routing.ts: only `/orgs/leads` reads are interactive).
 */
import { Router, type Response } from "express";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { errorMessage } from "../lib/db-error.js";
import { fetchCompanyResearchedUnits, fetchFactUnits, fetchLeadFoundUnits, type UnitsPage } from "../lib/provider-units.js";
import {
  PROVIDER_UNIT_READS,
  UnitsQueryError,
  parseUnitsQuery,
  type FactUnitOutcome,
  type ProviderUnitOutcome,
  type UnitsFilters,
} from "../lib/provider-units-query.js";
import { acceptQuery } from "../lib/query-params.js";
import { READ_QUERY_PARAMS } from "../lib/read-query-vocabulary.js";

const router = Router();

function unitsHandler(outcome: ProviderUnitOutcome) {
  const read = PROVIDER_UNIT_READS.find((r) => r.outcome === outcome);
  if (!read) throw new Error(`[lead-service] provider-units: ${outcome} is not a Provider read of this service`);
  const fetchUnits = (filters: UnitsFilters): Promise<UnitsPage<unknown>> =>
    read.kind === "lead_found"
      ? fetchLeadFoundUnits(filters)
      : read.kind === "company_researched"
        ? fetchCompanyResearchedUnits(filters)
        : fetchFactUnits(outcome as FactUnitOutcome, filters);
  return async (req: AuthenticatedRequest, res: Response) => {
    const orgId = req.orgId as string;
    try {
      // `orgId` on the query is a staff key's target (acceptQuery): never a filter of this read.
      const filters = parseUnitsQuery(read.kind, orgId, req.query as Record<string, unknown>);
      const page = await fetchUnits(filters);
      return res.status(200).json({ outcome, count: page.units.length, units: page.units, nextCursor: page.nextCursor });
    } catch (error: unknown) {
      if (error instanceof UnitsQueryError) return res.status(400).json({ error: error.code, message: error.message });
      // Fail loud: an empty page on a read failure would read as "no Unit exists".
      console.error(`[lead-service] provider-units: ${outcome} failed for org=${orgId}: ${errorMessage(error)}`);
      return res.status(500).json({ error: "units_unreadable", message: errorMessage(error) });
    }
  };
}

// One explicit line per read: tests/unit/query-params.test.ts checks each is wired to its own vocabulary.
router.get("/orgs/units/lead-found", apiKeyAuth, requireOrgId, acceptQuery(READ_QUERY_PARAMS["GET /orgs/units/lead-found"]), unitsHandler("lead_found"));
router.get("/orgs/units/company-researched", apiKeyAuth, requireOrgId, acceptQuery(READ_QUERY_PARAMS["GET /orgs/units/company-researched"]), unitsHandler("company_researched"));
router.get("/orgs/units/website-visit", apiKeyAuth, requireOrgId, acceptQuery(READ_QUERY_PARAMS["GET /orgs/units/website-visit"]), unitsHandler("website_visit"));
router.get("/orgs/units/signup", apiKeyAuth, requireOrgId, acceptQuery(READ_QUERY_PARAMS["GET /orgs/units/signup"]), unitsHandler("signup"));
router.get("/orgs/units/form-submitted", apiKeyAuth, requireOrgId, acceptQuery(READ_QUERY_PARAMS["GET /orgs/units/form-submitted"]), unitsHandler("form_submitted"));
router.get("/orgs/units/purchase", apiKeyAuth, requireOrgId, acceptQuery(READ_QUERY_PARAMS["GET /orgs/units/purchase"]), unitsHandler("purchase"));
router.get("/orgs/units/meeting-booked", apiKeyAuth, requireOrgId, acceptQuery(READ_QUERY_PARAMS["GET /orgs/units/meeting-booked"]), unitsHandler("meeting_booked"));
router.get("/orgs/units/meeting-attended", apiKeyAuth, requireOrgId, acceptQuery(READ_QUERY_PARAMS["GET /orgs/units/meeting-attended"]), unitsHandler("meeting_attended"));
router.get("/orgs/units/paid-client", apiKeyAuth, requireOrgId, acceptQuery(READ_QUERY_PARAMS["GET /orgs/units/paid-client"]), unitsHandler("paid_client"));

export default router;
