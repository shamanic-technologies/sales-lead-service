import { queryProviderRequirements, registerProviderRequirement } from "./key-service-client.js";

// Maps each lead-service endpoint to the downstream apollo endpoints it calls.
// This is the source of truth for which lead routes proxy which apollo routes.
const ENDPOINT_MAPPING: Array<{
  lead: { method: string; path: string };
  downstream: Array<{ service: string; method: string; path: string }>;
}> = [
  {
    lead: { method: "POST", path: "/orgs/buffer/next" },
    downstream: [
      { service: "apollo", method: "POST", path: "/search/next" },
      { service: "apollo", method: "POST", path: "/search/dry-run" },
      { service: "apollo", method: "POST", path: "/enrich" },
      { service: "chat", method: "POST", path: "/complete" },
    ],
  },
  {
    lead: { method: "GET", path: "/orgs/stats" },
    downstream: [
      { service: "apollo", method: "POST", path: "/stats" },
    ],
  },
];

export async function registerProviders(): Promise<void> {
  // Collect all unique downstream endpoints to query in one batch
  const allDownstream = ENDPOINT_MAPPING.flatMap((m) => m.downstream);
  const uniqueDownstream = allDownstream.filter(
    (ep, i, arr) => arr.findIndex((e) => e.service === ep.service && e.method === ep.method && e.path === ep.path) === i
  );

  const { requirements } = await queryProviderRequirements(uniqueDownstream);
  if (requirements.length === 0) {
    console.log("[register-providers] No downstream provider requirements found");
    return;
  }

  // For each lead endpoint, find which providers its downstream endpoints need
  const registrations: Array<{ provider: string; method: string; path: string }> = [];

  for (const mapping of ENDPOINT_MAPPING) {
    const providers = new Set<string>();
    for (const downstream of mapping.downstream) {
      for (const req of requirements) {
        if (req.service === downstream.service && req.method === downstream.method && req.path === downstream.path) {
          providers.add(req.provider);
        }
      }
    }
    for (const provider of providers) {
      registrations.push({ provider, method: mapping.lead.method, path: mapping.lead.path });
    }
  }

  // Register each lead-service endpoint → provider mapping with key-service
  await Promise.all(
    registrations.map(({ provider, method, path }) =>
      registerProviderRequirement(provider, "lead", method, path)
        .catch((err) => console.warn(`[register-providers] Failed to register lead ${method} ${path} → ${provider}:`, err))
    )
  );
}
