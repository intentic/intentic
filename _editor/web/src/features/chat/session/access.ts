import {
    accessFor,
    type AccessKind,
    type AgentHarness,
    type AgentProvider,
    isTrialProvider,
    type KeyedProvider,
    type ProviderAccess,
    providerSpec,
} from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { accountsLoaded, providerAccounts, translatorAccounts } from "../accounts/providerAccounts";
import { acpProviders, endpointProviders, endpointsLoaded, trialStatus } from "../accounts/providerCatalog";

// Whether a provider can actually run, and what unlocks it: one rule, read by every surface that offers a
// provider (picker, connect gate, account panel). A catalog always has rows (every provider seeds a floor
// model), so having rows says nothing about readiness.

export interface ProviderAccessState {
    // Whether a turn on this provider can be sent right now.
    readonly ready: boolean;
    // Undefined for an ACP agent or endpoint: both carry their own credential, nothing left to connect.
    readonly access: ProviderAccess | undefined;
    // Whether any connected account of this provider has a credential that can no longer be refreshed.
    readonly needsReauth: boolean;
}

const accountsOf = (provider: AgentProvider) => providerAccounts.value[provider] ?? [];
const isAcp = (provider: AgentProvider): boolean => acpProviders.value.some((agent) => agent.id === provider);
const isEndpoint = (provider: AgentProvider): boolean => endpointProviders.value.some((endpoint) => endpoint.id === provider);

// Mirrors the daemon's own gate (agent.routes): keyed on how the credential is held (ProviderSpec.auth), not
// which provider. Grok alone is served both ways; `providerReadyOn` narrows to one harness.
export const providerReady = (provider: AgentProvider): boolean => {
    const spec = providerSpec(provider);
    if (spec?.auth.kind === `translator`) {
        const routed = translatorAccounts.value[provider as KeyedProvider].length > 0;
        // Grok's native xAI account counts too: the question is whether this provider can run at all.
        return routed || accountsOf(provider).length > 0;
    }
    // Trial existing isn't readiness: its daily allowance can be spent, unlike other endpoints' credentials.
    if (isTrialProvider(provider)) {
        return isEndpoint(provider) && trialStatus.value.available && trialStatus.value.remaining > 0;
    }
    // Everything else needs a stored account; an endpoint or installed ACP agent is ready just by existing.
    return accountsOf(provider).length > 0 || isAcp(provider) || isEndpoint(provider);
};

// Narrows providerReady to one harness: only Grok's credential depends on it (native xAI account vs. the translator's
// SuperGrok subscription). Named rather than derived, since every other provider's two harnesses share one credential.
export const providerReadyOn = (provider: AgentProvider, harness: AgentHarness): boolean => {
    if (provider === `grok`) {
        return harness === `claude-code` ? translatorAccounts.value.grok.length > 0 : accountsOf(provider).length > 0;
    }
    return providerReady(provider);
};

export const accessStateFor = (provider: AgentProvider): ProviderAccessState => ({
    ready: providerReady(provider),
    access: accessFor(provider),
    needsReauth: accountsOf(provider).some((account) => account.needsReauth === true),
});

/* WHETHER THERE IS A SIGN-IN HERE AT ALL, which is a different question from whether this provider is ready,
 * and the one a surface must ask BEFORE it offers a button.
 *
 * `accessFor` is already the product's answer to "is there something to connect", because it is a spec field
 * and the two families that carry their own credentials have no spec row: an installed ACP agent, and a model
 * endpoint, the free trial among them. Both are ready by existing, so a Connect on their row offers a handshake
 * that does not exist.
 *
 * Derived here rather than asked by elimination, which is exactly how the account card came to offer one. It
 * treated everything that was not a translator subscription as holding native accounts, so a provider with no
 * spec fell through: a fresh sandbox parks its first chat on the free trial, the card followed the chat, and
 * the empty row it drew read "endpoint/free-trial account · not connected" with a Connect beside it. */
export const hasSignIn = (provider: AgentProvider): boolean => accessFor(provider) !== undefined;

// How a locked provider states its price in one chip. `free` leads with the word that changes a decision, a
// user who has connected nothing should be able to see, without connecting anything, that one of these rows
// costs nothing; the others name what they'd have to already pay for.
const KIND_BADGE: Record<AccessKind, (requirement: string) => string> = {
    free: (requirement) => `Free · ${requirement}`,
    subscription: (requirement) => `Needs ${requirement}`,
};

// Chip a provider's section header shows: nothing once ready (a usable provider looks like the plain default),
// else its access requirement.
export const accessBadge = (provider: AgentProvider): string | undefined => {
    const state = accessStateFor(provider);
    if (state.ready || state.access === undefined) {
        return undefined;
    }
    return KIND_BADGE[state.access.kind](state.access.requirement);
};

// Connect gate's pitch and the button's accessible name (`action`); the visible chip just shows the provider's
// name. Grok's requirement depends on harness: under Claude Code it needs the translator's SuperGrok subscription.
export const connectPitch = (provider: AgentProvider, harness: AgentHarness): { copy: string; action: string } | undefined => {
    const access = accessFor(provider);
    if (access === undefined) {
        return undefined;
    }
    const runs = provider === `grok` && harness === `claude-code` ? `${access.runs} under Claude Code` : access.runs;
    return { copy: `Connect your ${access.requirement} to run ${runs}.`, action: `Connect ${access.requirement}` };
};

// Separate from accessBadge: the trial is an endpoint (accessFor rightly returns undefined), but the row needs
// a remaining count, not a price, and no Connect button, and nothing before the daemon confirms it.
export const trialBadge = (provider: AgentProvider): string | undefined => {
    if (!isTrialProvider(provider) || !trialStatus.value.available) {
        return undefined;
    }
    const { remaining } = trialStatus.value;
    return remaining > 0 ? `Free trial · ${remaining} left today` : `Free trial · used up today`;
};

// Whether the trial is spent: the row stops being an offer and points to the free, uncapped Google sign-in instead.
export const trialExhausted = (provider: AgentProvider): boolean =>
    isTrialProvider(provider) && trialStatus.value.available && trialStatus.value.remaining <= 0;

// Both accountsLoaded and endpointsLoaded must be true before a surface says "nothing to send with": the
// account half lands first and, alone, showed a connect wall a beat before the free trial arrived to contradict it.
export const accessKnown: ComputedRef<boolean> = computed(() => accountsLoaded.value && endpointsLoaded.value);
