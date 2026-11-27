/**
 * A person known by their MESSAGING HANDLE only (LEAD-REPLY-CHANNEL-1127-LS): someone writing to a brand's linked Pro
 * account on a bridged app (Telegram, LinkedIn, ...) often carries neither an email nor a phone (their app id is no
 * phone). crm-service names them by the string it already states to human-service: `msg:<network>:<id>`, e.g.
 * `msg:telegram:123456789`. network = a lowercase token, id = non-empty.
 *
 * The handle is stored verbatim (trimmed) as a `lead_contact_methods` row of channel `messaging_handle` and matched by
 * exact equality: one handle = one lead (`idx_lcm_channel_value`). Nothing here reads the network name (no rule keyed
 * on it), and a handle is never turned into an email or a phone.
 */
export const MESSAGING_HANDLE_CHANNEL = "messaging_handle";

const HANDLE_RE = /^msg:([a-z0-9][a-z0-9_.-]*):(\S.*)$/;

/** The handle as stored, or null when it is not `msg:<lowercase network>:<non-empty id>`. */
export function canonicalMessagingHandle(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value.length > 300) return null;
  const m = HANDLE_RE.exec(value);
  if (!m || m[2].trim().length === 0) return null;
  return value;
}
