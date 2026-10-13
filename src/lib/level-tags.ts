/**
 * The tags that sit ABOVE the lead, read for a chunk of rows in one go (LEAD-REFONTE-1013): the
 * company each lead is at (its key), the COMPANY-level marks and buyer status at these brands, and
 * which leads' HUMAN carries an opt-out. The lead-level marks are read by the caller as before
 * (lead-disqualification.ts `loadLiveMarks`).
 */
import { leadCompanyKeys, loadLiveCompanyMarks, type LeadDisqualification } from "./lead-disqualification.js";
import { loadCompanyStatus, type CompanyStatus } from "./company-status.js";
import { loadHumanOptOuts } from "./human-opt-out-read.js";

export interface LevelTags {
  companyKeyOf: Map<string, string>;
  companyMarks: Map<string, Map<string, LeadDisqualification>>;
  companyStatus: CompanyStatus;
  humanOptOuts: Set<string>;
}

export async function loadLevelTags(input: {
  orgId: string;
  brandIds: readonly string[];
  leadIds: readonly string[];
}): Promise<LevelTags> {
  const [companyKeyOf, humanOptOuts] = await Promise.all([leadCompanyKeys(input.leadIds), loadHumanOptOuts(input.leadIds)]);
  const keys = [...companyKeyOf.values()];
  const [companyMarks, companyStatus] = await Promise.all([
    loadLiveCompanyMarks({ orgId: input.orgId, brandIds: input.brandIds, companyKeys: keys }),
    loadCompanyStatus({ orgId: input.orgId, brandIds: input.brandIds, companyKeys: keys }),
  ]);
  return { companyKeyOf, companyMarks, companyStatus, humanOptOuts };
}
