#!/usr/bin/env bash
# ONE-TIME backfill of `lead_campaign_run_repoints` (migration 0096, WORKFLOW-SEND-HISTORY-1016).
#
# Why: before 0096 a retry-pool claim or a named serve re-pointed a `leads_campaigns` row at the asking run without
# recording that run's workflow, so `emailSends` would credit those sends to the SERVING workflow. The re-pointing
# run is still the row's `run_id` (a sent row is never claimed again), and runs-service holds its workflow.
#
# What it writes: one `recorded_by = 'backfill'` row per re-pointed row that has none yet:
#   retry claims  -> (row, run_id, runs.workflow_slug, retry_claimed_at, 'retry_claim') for retry_count > 0
#   named serves  -> (row, named_lead_serves.last_run_id, runs.workflow_slug, last_served_at, 'named_serve')
# Rows also re-pointed by a named serve take only the later of the two (their run_id belongs to it).
# Only rows the backfill read off runs-service are written; a run runs-service does not know is counted, not guessed.
#
# Properties: dry-run by default (prints counts, writes nothing), APPLY=1 writes; idempotent (skips rows that hold a
# repoint already); reversible: DELETE FROM lead_campaign_run_repoints WHERE recorded_by = 'backfill';
#
# Usage, on the box (root@167.233.196.79):
#   bash backfill-lead-campaign-run-repoints.sh          # dry run
#   APPLY=1 bash backfill-lead-campaign-run-repoints.sh  # write
set -euo pipefail
PSQL=(docker exec -i distribute-postgres-1 psql -U postgres -v ON_ERROR_STOP=1 -At)
WORK=$(mktemp -d /tmp/lcrr-backfill.XXXXXX)

"${PSQL[@]}" -d lead_service -c "COPY (
  SELECT lc.id, lc.run_id, lc.retry_claimed_at, 'retry_claim'
    FROM leads_campaigns lc
   WHERE lc.retry_count > 0 AND lc.run_id IS NOT NULL AND lc.retry_claimed_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM lead_campaign_run_repoints r WHERE r.lead_campaign_id = lc.id)
     AND NOT EXISTS (SELECT 1 FROM named_lead_serves n WHERE n.lead_campaign_id = lc.id AND n.last_served_at > lc.retry_claimed_at)
  UNION ALL
  SELECT n.lead_campaign_id, n.last_run_id, n.last_served_at, 'named_serve'
    FROM (SELECT DISTINCT ON (lead_campaign_id) * FROM named_lead_serves ORDER BY lead_campaign_id, last_served_at DESC) n
    JOIN leads_campaigns lc ON lc.id = n.lead_campaign_id
   WHERE n.last_run_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM lead_campaign_run_repoints r WHERE r.lead_campaign_id = n.lead_campaign_id)
     AND (lc.retry_claimed_at IS NULL OR n.last_served_at > lc.retry_claimed_at)
) TO STDOUT" > "$WORK/candidates.tsv"
echo "candidates: $(wc -l < "$WORK/candidates.tsv")"

# runs-service: the workflow of each re-pointing run (a run id that is not a uuid is skipped by the cast filter).
"${PSQL[@]}" -d runs_service -c "CREATE TEMP TABLE c(lc_id uuid, run_id text, at timestamptz, cause text); COPY c FROM STDIN;" \
  -c "COPY (SELECT c.lc_id, c.run_id, r.workflow_slug, c.at, c.cause FROM c JOIN runs r ON r.id::text = c.run_id) TO STDOUT" \
  < "$WORK/candidates.tsv" > "$WORK/resolved.tsv"
echo "resolved by runs-service: $(wc -l < "$WORK/resolved.tsv")"

if [ "${APPLY:-0}" != "1" ]; then
  echo "dry run: nothing written ($WORK)"
  exit 0
fi

"${PSQL[@]}" -d lead_service \
  -c "CREATE TEMP TABLE x(lc_id uuid, run_id text, workflow_slug text, at timestamptz, cause text); COPY x FROM STDIN;" \
  -c "INSERT INTO lead_campaign_run_repoints (lead_campaign_id, run_id, workflow_slug, repointed_at, cause, recorded_by)
      SELECT x.lc_id, x.run_id, x.workflow_slug, x.at, x.cause, 'backfill' FROM x
       WHERE EXISTS (SELECT 1 FROM leads_campaigns lc WHERE lc.id = x.lc_id)
         AND NOT EXISTS (SELECT 1 FROM lead_campaign_run_repoints r WHERE r.lead_campaign_id = x.lc_id)" \
  -c "SELECT 'written: ' || count(*) FROM lead_campaign_run_repoints WHERE recorded_by = 'backfill'" \
  < "$WORK/resolved.tsv"
