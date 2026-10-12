/**
 * A person known by a SOCIAL identity before any email (owner 2026-10-12: the people who engage with
 * our social posts are leads of the post's brand).
 *
 * Identity stays EMAIL-FIRST (leads-registry.ts): an email, once known, decides which lead a person
 * is. Until then a person is held by their social identity, stored like an email as
 * `lead_contact_methods` rows, unique per (channel, value):
 *   - `social`   = social-service's own person key (`linkedin:<profile id>` | `x:<handle>`), the one
 *                  key every engagement of that person carries;
 *   - `linkedin` = the LinkedIn vanity handle (`/in/<handle>`), when the engagement shows it;
 *   - `x`        = the X handle.
 * No read of a lead's contact (delivery overlay, send paths, reach) looks at these channels: every one
 * filters `channel = 'email'` (or `phone`).
 *
 * One person, one lead, in both orders:
 *   - an engager whose vanity handle matches a lead we already hold (a served lead carries the
 *     provider's `linkedin_url`) IS that lead (`resolveSocialLead`);
 *   - a lead served LATER with an email and that LinkedIn URL adopts the engager's lead, or folds it
 *     into the email owner (`findLeadBySocialLinkedin` + `foldSocialLead`, called by
 *     `upsertLeadFromPerson`), so the engagement stays on the person's timeline.
 */
import { sql } from "../db/index.js";

export const SOCIAL_CONTACT_SOURCE = "social-service";

/** The person as social-service serves it on an engagement fact. */
export interface SocialPerson {
  key: string;
  name: string | null;
  handle: string | null;
  profileUrl: string | null;
  urn: string | null;
  headline: string | null;
}

export interface SocialIdentity {
  /** social-service's person key, verbatim. */
  socialKey: string;
  /** LinkedIn vanity handle, lowercased; null when the engagement only shows the member id. */
  linkedinHandle: string | null;
  /** X handle, lowercased, no `@`. */
  xHandle: string | null;
  /** The profile URL a lead row may carry (vanity URL first, else what social-service served). */
  linkedinUrl: string | null;
}

/** The `/in/<handle>` of a LinkedIn profile URL, lowercased; null when the URL is not one. */
export function linkedinHandleOf(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const m = /linkedin\.com\/in\/([^/?#]+)/.exec(url.toLowerCase());
  return m ? m[1] : null;
}

/**
 * The identity one engager is held by. A LinkedIn member id (`ACoAA...`, the tail of the person key) is
 * NOT a vanity handle: it never matches a provider's `linkedin_url`, so it is kept as the `social` key
 * only.
 */
export function socialIdentityOf(platform: string, person: SocialPerson): SocialIdentity {
  if (!person.key) throw new Error("social person has no key");
  if (platform === "linkedin") {
    const memberId = person.key.startsWith("linkedin:") ? person.key.slice("linkedin:".length).toLowerCase() : null;
    const candidates = [person.handle?.toLowerCase() ?? null, linkedinHandleOf(person.profileUrl)];
    const vanity = candidates.find((h): h is string => !!h && h !== memberId) ?? null;
    return {
      socialKey: person.key,
      linkedinHandle: vanity,
      xHandle: null,
      linkedinUrl: vanity ? `https://www.linkedin.com/in/${vanity}` : person.profileUrl,
    };
  }
  if (platform === "x") {
    const fromKey = person.key.startsWith("x:") ? person.key.slice(2) : null;
    const handle = (person.handle ?? fromKey)?.replace(/^@/, "").toLowerCase() || null;
    return { socialKey: person.key, linkedinHandle: null, xHandle: handle, linkedinUrl: null };
  }
  return { socialKey: person.key, linkedinHandle: null, xHandle: null, linkedinUrl: null };
}

async function ownerOf(channel: string, value: string): Promise<string | null> {
  const rows = (await sql`
    SELECT lead_id::text AS lead_id FROM lead_contact_methods WHERE channel = ${channel} AND value = ${value} LIMIT 1
  `) as unknown as Array<{ lead_id: string }>;
  return rows[0]?.lead_id ?? null;
}

/**
 * The lead a provider already holds under this vanity handle (`leads.linkedin_url`, index 0070). Several
 * leads can carry one URL (provider id churn): the one holding an email wins, then the oldest.
 */
async function leadByLinkedinHandle(handle: string): Promise<string | null> {
  const rows = (await sql`
    SELECT l.id::text AS id
    FROM leads l
    WHERE substring(lower(l.linkedin_url) from 'linkedin\\.com/in/([^/?#]+)') = ${handle}
    ORDER BY EXISTS (SELECT 1 FROM lead_contact_methods cm WHERE cm.lead_id = l.id AND cm.channel = 'email') DESC,
      l.created_at ASC, l.id ASC
    LIMIT 1
  `) as unknown as Array<{ id: string }>;
  return rows[0]?.id ?? null;
}

/** Hold `value` on `leadId`; false when another lead already holds it (one value, one lead). */
async function holdContact(leadId: string, channel: string, value: string): Promise<boolean> {
  const inserted = (await sql`
    INSERT INTO lead_contact_methods (lead_id, channel, value, source)
    VALUES (${leadId}::uuid, ${channel}, ${value}, ${SOCIAL_CONTACT_SOURCE})
    ON CONFLICT DO NOTHING
    RETURNING id
  `) as unknown as unknown[];
  if (inserted.length > 0) return true;
  return (await ownerOf(channel, value)) === leadId;
}

export interface ResolvedSocialLead {
  leadId: string;
  /** A new lead was minted for this person. */
  created: boolean;
}

/**
 * The lead of this engager, minted when nobody holds them yet. Precedence: the lead holding the
 * social key, then the vanity handle (held, or on a provider's `linkedin_url`), then the X handle.
 * Race-safe: the `social` key is unique, so a concurrent writer's lead wins and ours is dropped.
 */
export async function resolveSocialLead(identity: SocialIdentity, person: SocialPerson): Promise<ResolvedSocialLead> {
  let leadId =
    (await ownerOf("social", identity.socialKey)) ??
    (identity.linkedinHandle
      ? (await ownerOf("linkedin", identity.linkedinHandle)) ?? (await leadByLinkedinHandle(identity.linkedinHandle))
      : null) ??
    (identity.xHandle ? await ownerOf("x", identity.xHandle) : null);
  let created = false;

  if (!leadId) {
    const rows = (await sql`
      INSERT INTO leads (name, headline, linkedin_url, metadata)
      VALUES (${person.name}, ${person.headline}, ${identity.linkedinUrl},
        ${JSON.stringify({ socialPerson: person })}::jsonb)
      RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;
    leadId = rows[0].id;
    created = true;
    if (!(await holdContact(leadId, "social", identity.socialKey))) {
      const owner = await ownerOf("social", identity.socialKey);
      await sql`DELETE FROM leads WHERE id = ${leadId}::uuid`;
      if (!owner) throw new Error(`social key ${identity.socialKey} collided but no lead holds it`);
      return { leadId: owner, created: false };
    }
  } else if (!(await holdContact(leadId, "social", identity.socialKey))) {
    console.warn(`[lead-service] social identity: key ${identity.socialKey} is held by another lead than ${leadId}`);
  }

  if (identity.linkedinHandle && !(await holdContact(leadId, "linkedin", identity.linkedinHandle))) {
    console.warn(`[lead-service] social identity: linkedin ${identity.linkedinHandle} is held by another lead than ${leadId}`);
  }
  if (identity.xHandle && !(await holdContact(leadId, "x", identity.xHandle))) {
    console.warn(`[lead-service] social identity: x ${identity.xHandle} is held by another lead than ${leadId}`);
  }
  if (!created) {
    await sql`
      UPDATE leads SET
        name = COALESCE(name, ${person.name}),
        headline = COALESCE(headline, ${person.headline}),
        linkedin_url = COALESCE(linkedin_url, ${identity.linkedinUrl})
      WHERE id = ${leadId}::uuid
        AND (name IS NULL OR headline IS NULL OR linkedin_url IS NULL)
    `;
  }
  return { leadId, created };
}

/** The lead holding this LinkedIn profile as a social identity (an engager), or null. */
export async function findLeadBySocialLinkedin(linkedinUrl: string | null | undefined): Promise<string | null> {
  const handle = linkedinHandleOf(linkedinUrl);
  return handle ? ownerOf("linkedin", handle) : null;
}

/**
 * Fold a lead known only by its social identity into the lead an email (or provider id) found for the
 * same person: its social contact methods, timeline facts and "found by the post's campaign" rows move over, and the emptied row is dropped
 * when nothing else points at it. A lead that is more than a social identity (an email, a serve) is a
 * person of its own: nothing is moved and the case is logged.
 */
export async function foldSocialLead(fromLeadId: string, intoLeadId: string): Promise<boolean> {
  if (fromLeadId === intoLeadId) return false;
  return sql.begin(async (txn) => {
    // postgres.js types a transaction without its call signature; it is the same tagged template.
    const tx = txn as unknown as typeof sql;
    const blockers = (await tx`
      SELECT
        EXISTS (SELECT 1 FROM lead_contact_methods WHERE lead_id = ${fromLeadId}::uuid AND channel IN ('email', 'phone')) AS has_contact,
        EXISTS (SELECT 1 FROM leads_campaigns WHERE lead_id = ${fromLeadId}::uuid
          AND status_reason IS DISTINCT FROM 'social_engagement') AS has_serve
    `) as unknown as Array<{ has_contact: boolean; has_serve: boolean }>;
    if (blockers[0].has_contact || blockers[0].has_serve) {
      console.warn(
        `[lead-service] social identity: lead ${fromLeadId} holds the same LinkedIn as ${intoLeadId} but is a person of its own (contact or serve); not folded`,
      );
      return false;
    }
    await tx`UPDATE lead_contact_methods SET lead_id = ${intoLeadId}::uuid WHERE lead_id = ${fromLeadId}::uuid`;
    // The engager's "found by the post's campaign" rows follow the person (one per campaign: the email owner's
    // own row for that campaign wins and the engager's is dropped).
    await tx`
      DELETE FROM leads_campaigns f WHERE f.lead_id = ${fromLeadId}::uuid
        AND EXISTS (SELECT 1 FROM leads_campaigns t WHERE t.lead_id = ${intoLeadId}::uuid AND t.campaign_id = f.campaign_id)
    `;
    await tx`UPDATE leads_campaigns SET lead_id = ${intoLeadId}::uuid, updated_at = now() WHERE lead_id = ${fromLeadId}::uuid`;
    await tx`UPDATE lead_timeline_facts SET lead_id = ${intoLeadId}::uuid, updated_at = now() WHERE lead_id = ${fromLeadId}::uuid`;
    await tx`
      DELETE FROM leads l WHERE l.id = ${fromLeadId}::uuid
        AND NOT EXISTS (SELECT 1 FROM conversion_events WHERE matched_lead_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM crm_pairing_matches WHERE matched_lead_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM crm_pairing_judgments WHERE lead_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM crm_pairing_rulings WHERE lead_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM lead_step_disqualifications WHERE lead_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM lead_step_cause_statements WHERE lead_id = l.id)
        AND NOT EXISTS (SELECT 1 FROM leads_organizations WHERE lead_id = l.id)
    `;
    console.log(`[lead-service] social identity: folded engager lead ${fromLeadId} into ${intoLeadId}`);
    return true;
  }) as Promise<boolean>;
}
