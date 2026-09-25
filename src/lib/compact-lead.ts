import type { BasicLeadRow } from "./basic-leads.js";
import type { FlattenedStatus } from "./delivery-flatten.js";

/**
 * One row of `?view=compact`: WHO the lead is, WHICH campaign and workflow served them, and what the
 * delivery layer measured — exactly what a consumer computing figures over a brand's whole
 * population reads, and nothing it does not.
 *
 * It exists because features-service computes a brand's revenue, funnel counts and per-lead outcomes
 * by walking the brand's entire population, and `view=basic` answered that walk with ~2.2 KB a row
 * (audience card, offer card, standing, closed deal, run ids, timestamps, headline, LinkedIn URL…)
 * of which the engine read a quarter — 110 MB for the largest brand. Every value here is read off
 * the SAME row and the SAME flattened overlay `view=basic` emits, so a field present in both can
 * never disagree. The audience, offer and standing resolvers are not run at all for this view.
 */
export function toCompactLead(
  r: BasicLeadRow,
  delivery: FlattenedStatus,
  crmPositiveReplyAt: string | null,
) {
  const org = r.lead?.organization ?? null;
  return {
    id: r.id,
    leadId: r.leadId,
    campaignId: r.campaignId,
    workflowSlug: r.workflowSlug ?? null,
    status: r.status,
    email: r.email?.value ?? "",
    lead: r.lead
      ? {
          firstName: r.lead.firstName,
          lastName: r.lead.lastName,
          photoUrl: r.lead.photoUrl,
          currentTitle: r.lead.currentTitle,
          seniority: r.lead.seniority,
          organization: org
            ? {
                id: org.id,
                name: org.name,
                logoUrl: org.logoUrl,
                primaryDomain: org.primaryDomain,
                websiteUrl: org.websiteUrl,
                industry: org.industry,
                estimatedNumEmployees: org.estimatedNumEmployees,
                city: org.city,
                country: org.country,
              }
            : null,
        }
      : null,
    contacted: delivery.contacted,
    sent: delivery.sent,
    delivered: delivery.delivered,
    opened: delivery.opened,
    clicked: delivery.clicked,
    bounced: delivery.bounced,
    unsubscribed: delivery.unsubscribed,
    replied: delivery.replied,
    replyClassification: delivery.replyClassification,
    // A positive reply the customer's OWN CRM evidences (their form, submitted after our first
    // delivered email — see crm-positive-reply-dates.ts), dated by the CRM. Null when there is none.
    // It is the same fact as `replied && replyClassification === "positive"`, kept apart so the
    // delivery evidence above stays exactly what the sender measured: a consumer counting positive
    // replies counts a person once when either says so.
    crmPositiveReplyAt,
  };
}

/** One element of `?view=compact`, and of the change feed that keeps a copy of it current. */
export type CompactLead = ReturnType<typeof toCompactLead>;
