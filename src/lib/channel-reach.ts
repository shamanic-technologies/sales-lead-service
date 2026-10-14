import { loadChannelContactMethods } from "./sourcing-origin.js";
import type { ReachMethod } from "./people-client.js";

/**
 * WHO A PIPE CAN REACH (owner 2026-10-12): a serve made FOR a pipe never consumes a person the pipe cannot write to.
 *
 * The outreach channel a lead is served for states how it reaches a person in features-service's catalogue
 * (`contactMethodsByChannel`: phone for WhatsApp / SMS / calls, email for email, a profile for the social channels).
 * lead-service holds no slug list of its own: it reads that statement and passes it on every serve as `reachableBy`
 * (human-service, which pushes it down to crm-service), and applies it to its own pools (retry pool, source stock,
 * released people) as contact methods the lead must carry.
 *
 * `reachableBy` speaks `email | phone`. A channel stating a method outside it (a LinkedIn profile...) or stating
 * nothing passes NO requirement (today's behaviour) and is logged: the requirement is unknown, not "none".
 */
export const REACH_METHODS: readonly ReachMethod[] = ["email", "phone"];

/** Each "reach unknown" line is written once per channel per process (it fires on every serve otherwise). */
const warned = new Set<string>();
function warnOnce(channelSlug: string, line: string): void {
  if (warned.has(channelSlug)) return;
  warned.add(channelSlug);
  console.warn(line);
}

/**
 * PURE: what a serve requires, the channel's methods and the workflow's stated ones together (ALL required). The
 * workflow's word is its pipe's LEAD STRATEGY (owner 2026-10-14, LEAK-1012: a WhatsApp-reachable strategy and an
 * email-reachable one of the same CRM source never take each other's people). Null = nothing required by either.
 */
export function combineReach(channel: ReachMethod[] | null, stated: readonly ReachMethod[] | null): ReachMethod[] | null {
  const all = new Set<ReachMethod>([...(channel ?? []), ...(stated ?? [])]);
  return all.size === 0 ? null : [...all].sort();
}

export async function channelReachableBy(channelSlug: string): Promise<ReachMethod[] | null> {
  const methods = await loadChannelContactMethods(channelSlug);
  if (!methods || methods.length === 0) {
    warnOnce(channelSlug, `[lead-service] channel reach unknown: ${channelSlug} states no contact method, serve passes no reachableBy`);
    return null;
  }
  const unknown = methods.filter((m) => !(REACH_METHODS as readonly string[]).includes(m));
  if (unknown.length > 0) {
    warnOnce(
      channelSlug,
      `[lead-service] channel reach not expressible: ${channelSlug} needs ${methods.join(",")} (${unknown.join(",")} outside reachableBy), serve passes no reachableBy`,
    );
    return null;
  }
  return [...new Set(methods as ReachMethod[])].sort();
}
