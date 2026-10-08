import { type AgentCapabilities, type PrivacyShieldStatus, providerLabel, trustedInConversation } from "@intentic/sandbox-contract";

// Where a conversation stands with the privacy shield before anything is sent. Said above the composer only when it is
// already known that a turn would be turned away, so nothing here guesses from the provider alone (2026-10-08): the
// shield reads every runtime it can by content, and only what it found, or a runtime it cannot read at all, refuses.
// - A runtime with no seam at all (an ACP agent, Pi: privacy `none`) is turned away by its runtime alone, before a word
//   is read (privacy-shield.ts `admit`), so that is knowable here and said before the send: told only after it, the
//   refusal read as something found in the message (2026-10-02).
// - A runtime the shield reads through its hooks (Cursor: privacy `hooks`) runs, and its channels are masked as it
//   reads them; the one thing that turns it away is personal data in what it loads itself (its project rules), found
//   when a turn was sent. That finding is said here from then on, with the way through, until a turn runs.

export type PrivacyStanding =
    // The next turn would be turned away: the shield is on, the runtime can't be read at all, the provider isn't trusted.
    | { readonly kind: `refused`; readonly provider: string; readonly label: string }
    // The last turn was turned away for what the shield found, in the daemon's own words.
    | { readonly kind: `found`; readonly provider: string; readonly label: string; readonly reason: string | undefined }
    // It runs because the owner let this provider read this conversation as it is, and nowhere else.
    | { readonly kind: `granted`; readonly provider: string; readonly label: string };

// The refusals that come from what the shield read on a runtime it reads by content: a finding in what the runtime loads
// itself, or the shield unable to read the turn at all (its hooks missing, its policy unreadable).
const SHIELD_REFUSALS: ReadonlySet<string> = new Set([`privacy-instructions`, `privacy-unshielded`]);

/** Nothing to say while the shield is off or watching, for a runtime the gateway masks, or for a provider trusted everywhere: that last is the owner's standing choice, said on the Safety page. */
export const privacyStanding = (
    status: PrivacyShieldStatus | undefined,
    provider: string,
    capabilities: Pick<AgentCapabilities, `privacy`>,
    conversationId: string,
    failure?: { readonly code: string; readonly text?: string | undefined },
): PrivacyStanding | undefined => {
    if (status === undefined || status.policy.mode !== `on` || capabilities.privacy === `gateway`) {
        return undefined;
    }
    const known = status.providers.find((entry) => entry.id === provider);
    if (known?.local === true || status.policy.trusted.includes(provider)) {
        return undefined;
    }
    const label = known?.label ?? providerLabel(provider);
    if (trustedInConversation(status.policy, provider, conversationId)) {
        return { kind: `granted`, provider, label };
    }
    if (capabilities.privacy === `none`) {
        return { kind: `refused`, provider, label };
    }
    return failure !== undefined && SHIELD_REFUSALS.has(failure.code) ? { kind: `found`, provider, label, reason: failure.text } : undefined;
};
