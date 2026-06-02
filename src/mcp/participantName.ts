/**
 * Pure helper for resolving a Google Meet Participant resource to a human display name.
 *
 * A Meet REST API v2 Participant object carries exactly one of `signedinUser`,
 * `anonymousUser`, or `phoneUser`, each with an optional `displayName`. This module
 * is intentionally side-effect-free (no fetch, no cache) so it can be unit-tested
 * in isolation; the MCP server wires it into an authenticated, cached fetch.
 */

export interface MeetParticipant {
  name?: string | null;
  signedinUser?: { displayName?: string | null } | null;
  anonymousUser?: { displayName?: string | null } | null;
  phoneUser?: { displayName?: string | null } | null;
}

/**
 * Returns the best human display name for a participant, applying precedence
 * signedinUser → anonymousUser → phoneUser. Returns "" when none is available
 * (callers should fall back to the raw resource name).
 */
export function participantDisplayName(p: MeetParticipant | undefined | null): string {
  if (!p) return "";
  return (
    p.signedinUser?.displayName ||
    p.anonymousUser?.displayName ||
    p.phoneUser?.displayName ||
    ""
  );
}
