import type { AgentCapabilities } from "@intentic/sandbox-contract/models/agent-runtimes";
import type { PrivacyShieldStatus } from "@intentic/sandbox-contract/schemas/privacy";
import { isPrivacyRefusal, type PrivacyBypass, shieldVerdict, turnRoute } from "@intentic/sandbox-contract/schemas/privacy-egress";
import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";

// Where a conversation stands with the privacy shield before anything is sent: the daemon's own verdict on the route its
// next turn would take (privacy-egress.ts), read here off the same policy, so the strip above the composer says what the
// turn will meet and never a guess of its own. Before 2026-10-20 it re-derived that verdict and drifted from it: it warned
// on opening a Cursor composer (2026-10-08), whose turns the shield reads through hooks, and said nothing about a
// conversation on a runner (2026-10-11) until its turn came back refused.
// - Refused: the shield masks, the provider isn't trusted, and the turn would pass no seam (a runtime the shield can't
//   read at all, or a runner calling its provider from its own machine). Said before the send, with the way through:
//   told only after it, the refusal read as something found in the message (2026-10-02).
// - Found: the shield reads the turn and masks, and the last turn was turned away where the next would be too: for what
//   it found where it could not mask (a hooked runtime's own project rules), or on a route only a turn finds (Codex on
//   the container's own key), in the daemon's own words, until a turn runs.
// - Granted: it runs as it is because the owner let this provider read this conversation, and nowhere else.

export type PrivacyStanding =
    | { readonly kind: `refused`; readonly provider: string; readonly label: string; readonly runner?: string }
    | { readonly kind: `found`; readonly provider: string; readonly label: string; readonly reason: string | undefined }
    | { readonly kind: `granted`; readonly provider: string; readonly label: string };

// How the conversation's last turn failed: its code and words, and for a privacy refusal the route its verdict refused
// (the error frame's `privacyRoute`) and the provider it ran on, where the caller has them.
export interface LastFailure {
    readonly code: string;
    readonly text?: string | undefined;
    readonly route?: PrivacyBypass | undefined;
    readonly provider?: string | undefined;
}

// Whether the next turn on a route the shield reads would meet the refusal the last one ended on (2026-10-21: a runner's
// refusal, or another provider's, was said as found with a grant that would clear nothing). A runner or a runtime the
// shield can't read is the verdict's own to say (`refused`); a route the verdict can't see from here is only a turn's to
// find: the container's own key, a shared server started before the shield. Untyped, a refusal is a hooked runtime's (what
// it found in the runtime's own rules, its hooks missing), as it was before the strip read the verdict.
const refusalAhead = (failure: LastFailure | undefined, provider: string, privacy: AgentCapabilities[`privacy`]): boolean => {
    if (failure === undefined || !isPrivacyRefusal(failure.code) || (failure.provider !== undefined && failure.provider !== provider)) {
        return false;
    }
    return failure.route === undefined ? privacy === `hooks` : failure.route === `own-key` || failure.route === `shared-server`;
};

/** Nothing to say while the verdict is to watch, to mask with nothing refused yet, or to pass for any reason but this conversation's grant (the owner's standing choices are said on the Safety page). */
export const privacyStanding = (
    status: PrivacyShieldStatus | undefined,
    provider: string,
    capabilities: Pick<AgentCapabilities, `privacy`>,
    conversationId: string,
    failure?: LastFailure,
    runner?: string,
): PrivacyStanding | undefined => {
    if (status === undefined) {
        return undefined;
    }
    const known = status.providers.find((entry) => entry.id === provider);
    const label = known?.label ?? providerLabel(provider);
    const verdict = shieldVerdict(status.policy, { provider, local: known?.local === true, conversationId, route: turnRoute(capabilities.privacy, runner) });
    switch (verdict.kind) {
        case `refuse`:
            return runner === undefined ? { kind: `refused`, provider, label } : { kind: `refused`, provider, label, runner };
        case `pass`:
            return verdict.because === `granted` ? { kind: `granted`, provider, label } : undefined;
        case `mask`:
            return refusalAhead(failure, provider, capabilities.privacy) ? { kind: `found`, provider, label, reason: failure?.text } : undefined;
        case `watch`:
            return undefined;
    }
};
