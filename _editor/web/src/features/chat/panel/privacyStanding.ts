import { type AgentCapabilities, type PrivacyShieldStatus, providerLabel, trustedInConversation } from "@intentic/sandbox-contract";

// Where a conversation stands with the privacy shield before anything is sent. The daemon turns a provider the gateway
// cannot cover away by its runtime alone, before reading a word (privacy-shield.ts `admit`), so this is knowable here and
// said above the composer: told only after the send, the refusal read as something found in the message (2026-10-02).

export type PrivacyStanding =
    // The next turn would be turned away: the shield is on, the runtime can't be shielded, the provider isn't trusted.
    | { readonly kind: `refused`; readonly provider: string; readonly label: string }
    // It runs because the owner let this provider read this conversation as it is, and nowhere else.
    | { readonly kind: `granted`; readonly provider: string; readonly label: string };

/** Nothing to say while the shield is off or watching, for a runtime the gateway masks, or for a provider trusted everywhere: that last is the owner's standing choice, said on the Safety page. */
export const privacyStanding = (
    status: PrivacyShieldStatus | undefined,
    provider: string,
    capabilities: Pick<AgentCapabilities, `privacy`>,
    conversationId: string,
): PrivacyStanding | undefined => {
    if (status === undefined || status.policy.mode !== `on` || capabilities.privacy === `gateway`) {
        return undefined;
    }
    const known = status.providers.find((entry) => entry.id === provider);
    if (known?.local === true || status.policy.trusted.includes(provider)) {
        return undefined;
    }
    const label = known?.label ?? providerLabel(provider);
    return { kind: trustedInConversation(status.policy, provider, conversationId) ? `granted` : `refused`, provider, label };
};
