import { RUNS_SERVICE_URL, RUNS_SERVICE_API_KEY } from "../config.js";

const IDENTITY_HEADERS = [
  "x-org-id",
  "x-user-id",
  "x-brand-id",
  "x-campaign-id",
  "x-workflow-slug",
  "x-feature-slug",
] as const;

export async function traceEvent(
  runId: string,
  payload: {
    service: string;
    event: string;
    detail?: string;
    level?: "info" | "warn" | "error";
    data?: Record<string, unknown>;
  },
  headers: Record<string, string | string[] | undefined>,
): Promise<void> {
  if (!RUNS_SERVICE_URL || !RUNS_SERVICE_API_KEY) {
    console.error("[lead-service] RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not set, skipping trace event");
    return;
  }
  try {
    const forwardHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": RUNS_SERVICE_API_KEY,
    };
    for (const key of IDENTITY_HEADERS) {
      const val = headers[key];
      if (val) forwardHeaders[key] = val as string;
    }

    await fetch(`${RUNS_SERVICE_URL}/v1/runs/${runId}/events`, {
      method: "POST",
      headers: forwardHeaders,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.error("[lead-service] Failed to trace event:", err);
  }
}
