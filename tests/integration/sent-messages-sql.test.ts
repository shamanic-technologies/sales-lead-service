/**
 * WRITTEN-BY-1019-SENDER: every message we sent one lead, any channel, each with the run that wrote it,
 * against a REAL database (raw statements over outreach_facts, crm_facts, followup_actions, repoints).
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const { sql } = await import("../../src/db/index.js");
const { readSentMessages, leadBelongsToOrg } = await import("../../src/lib/sent-messages.js");
const { recordActedByEmail } = await import("../../src/lib/followup-actions.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("sent messages read against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const cCold = `cCold-${tag}`;
  const cFu = `cFu-${tag}`;
  let seq = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const nextSeq = () => (seq += 1n).toString();

  async function outreach(subject: string, type: string, email: string, campaignId: string, at: string, raw: Record<string, unknown> = {}) {
    await sql`
      INSERT INTO outreach_facts (seq, subject_key, type, occurred_at, lead_email, org_id, campaign_id, brand_ids, raw)
      VALUES (${nextSeq()}::bigint, ${subject}, ${type}, ${at}::timestamptz, ${email}, ${orgId}, ${campaignId},
              ARRAY[${brandId}]::text[], ${JSON.stringify(raw)}::jsonb)
    `;
  }

  it("lists every message with its writer, and records the acting run's workflow version on the ledger", async () => {
    const email = `p-${tag}@example.test`;
    const [lead] = (await sql`INSERT INTO leads (first_name, last_name) VALUES ('Pat', 'Doe') RETURNING id::text AS id`) as unknown as Array<{ id: string }>;
    await sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${lead.id}::uuid, 'email', ${email.toUpperCase()}, 'itest'), (${lead.id}::uuid, 'phone', '+33 6 12 34 56 78', 'itest')`;
    const [row] = (await sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, run_id, workflow_slug, served_at)
      VALUES (${lead.id}::uuid, ${cCold}, ${orgId}, ARRAY[${brandId}]::text[], 'served', 'run-serve', 'cold-alpha', '2026-10-01T00:00:00Z')
      RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;
    // A retry claim handed the row to another run before the second email.
    await sql`
      INSERT INTO lead_campaign_run_repoints (lead_campaign_id, run_id, workflow_slug, repointed_at, cause)
      VALUES (${row.id}::uuid, 'run-retry', 'cold-alpha-v2', '2026-10-03T00:00:00Z', 'retry_claim')
    `;
    await outreach(`ievt:s1-${tag}`, "email_sent", email, cCold, "2026-10-02T00:00:00Z");
    await outreach(`ievt:s2-${tag}`, "email_sent", email, cCold, "2026-10-04T00:00:00Z");
    // A withdrawn subject is absent.
    await outreach(`ievt:s3-${tag}`, "email_sent", email, cCold, "2026-10-05T00:00:00Z");
    await outreach(`ievt:s3-${tag}`, "withdrawn", email, cCold, "2026-10-05T00:00:00Z");
    // Our reply, sent by a person.
    await outreach(`rsent:h-${tag}`, "reply_sent", email, cCold, "2026-10-06T00:00:00Z", { replySent: { sentBy: "human" } });
    // Another org's fact never leaks.
    await sql`
      INSERT INTO outreach_facts (seq, subject_key, type, occurred_at, lead_email, org_id, campaign_id, brand_ids, raw)
      VALUES (${nextSeq()}::bigint, ${`ievt:foreign-${tag}`}, 'email_sent', now(), ${email}, ${randomUUID()}, ${cCold}, ARRAY[${brandId}]::text[], '{}'::jsonb)
    `;

    // The follow-up workflow acts (its run recorded it, with its version) and its WhatsApp message lands in the crm copy.
    const outcome = await recordActedByEmail({
      orgId, leadCampaignId: row.id, actingCampaignId: cFu, runId: `run-fu-${tag}`,
      workflowSlug: "ai-follow-up-whatsapp-v3", llmAlias: "claude-sonnet-5", nowIso: "2026-10-10T10:00:00.000Z",
    });
    expect(outcome).toBe("recorded");
    const [stored] = (await sql`SELECT workflow_slug, llm_alias FROM followup_actions WHERE run_id = ${`run-fu-${tag}`}`) as unknown as Array<{ workflow_slug: string; llm_alias: string }>;
    expect(stored.workflow_slug).toBe("ai-follow-up-whatsapp-v3");
    expect(stored.llm_alias).toBe("claude-sonnet-5");
    // An act recorded without an LLM (as every act before BEST-TPL-LLM-1022-LS): unpaired, it stands as its own record.
    expect(
      await recordActedByEmail({
        orgId, leadCampaignId: row.id, actingCampaignId: cFu, runId: `run-old-${tag}`,
        workflowSlug: "ai-follow-up-whatsapp-v2", nowIso: "2026-10-08T10:00:00.000Z",
      }),
    ).toBe("recorded");
    const waFact = randomUUID();
    await sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${waFact}, ${nextSeq()}::bigint, ${orgId}, ${brandId}, 'pk', ARRAY[]::text[], ARRAY['+33612345678']::text[], 'message_out',
              '2026-10-10T10:00:20Z', 'sent_at', 'matrix', ${`ref-${tag}`}, '{"channel":"whatsapp"}'::jsonb, '{}'::jsonb)
    `;

    expect(await leadBelongsToOrg(orgId, lead.id)).toBe(true);
    expect(await leadBelongsToOrg(randomUUID(), lead.id)).toBe(false);

    const messages = await readSentMessages(orgId, lead.id);
    expect(messages.map((m) => [m.id, m.kind, m.channel, m.writtenBy.by, m.writtenBy.basis, m.writtenBy.workflowSlug, m.writtenBy.runId])).toEqual([
      [`ievt:s1-${tag}`, "email_sent", "email", "workflow", "holding_run", "cold-alpha", "run-serve"],
      [`ievt:s2-${tag}`, "email_sent", "email", "workflow", "holding_run", "cold-alpha-v2", "run-retry"],
      [`rsent:h-${tag}`, "reply_sent", "email", "person", "person", null, null],
      [expect.any(String), "followup_act", null, "workflow", "recorded_act", "ai-follow-up-whatsapp-v2", `run-old-${tag}`],
      [waFact, "message_out", "whatsapp", "workflow", "recorded_act", "ai-follow-up-whatsapp-v3", `run-fu-${tag}`],
    ]);
    expect(messages[1].writtenBy.workflowSource).toBe("retry_claim");
    expect(messages[4].writtenBy.campaignId).toBe(cFu);
    // Which LLM wrote each: stated by the acting run, unknown with a reason otherwise.
    expect(messages.map((m) => [m.writtenBy.llmAlias, m.writtenBy.llmAliasReason])).toEqual([
      [null, "no_recorded_act"],
      [null, "no_recorded_act"],
      [null, "no_recorded_act"],
      [null, "not_stated"],
      ["claude-sonnet-5", null],
    ]);
  });
});
