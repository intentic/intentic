import { accessFor, type AccessKind, type AgentHarness, type AgentProvider, type ProviderAccess } from "@intentic/sandbox-contract";
import { acpProviders, endpointProviders, providerAccounts, translatorAccounts } from "./conversation";

/* CAN THIS PROVIDER ACTUALLY RUN, and what does it take to unlock it — one rule, read by every surface that
 * offers a provider (the model picker's rows and rail, the connect gate above the composer, the account panel).
 * It existed only inside useChat before, as the composer's own gate, which is why the picker listed Kimi models
 * to a user with no Kimi Code subscription exactly as it listed the ones they could send to: a catalog is deliberately
 * never empty daemon-side (every provider serves a seed floor so a turn always resolves a model), so "has rows"
 * says nothing at all about "can send".
 *
 * The requirement differs per provider and that difference is the useful part — a Google sign-in costs nothing
 * and a ChatGPT subscription costs money, so the picker states which, rather than flattening both to "locked". */

export interface ProviderAccessState {
    // Whether a turn on this provider can be sent right now.
    readonly ready: boolean;
    // Absent for an ACP agent and for a model endpoint — both carry their own credentials, so each is ready by
    // being installed and there is nothing left to connect.
    readonly access: ProviderAccess | undefined;
    // Whether any connected account of this provider has a credential that can no longer be refreshed.
    readonly needsReauth: boolean;
}

const accountsOf = (provider: AgentProvider) => providerAccounts.value[provider] ?? [];
const isAcp = (provider: AgentProvider): boolean => acpProviders.value.some((agent) => agent.id === provider);
const isEndpoint = (provider: AgentProvider): boolean => endpointProviders.value.some((endpoint) => endpoint.id === provider);

// Whether a provider can serve a fresh conversation. Mirrors the daemon's own gate (agent.routes): codex and
// kimi and gemini authenticate ONLY through the translator's subscription, grok through either its native xAI account or
// the translator, everything else through a daemon-stored account. Harness-independent on purpose — this answers
// "is this provider usable at all", which is what a model row needs; the composer's gate (useChat.chatReady)
// narrows it to the one harness the active conversation is actually set to.
export const providerReady = (provider: AgentProvider): boolean => {
    if (provider === `codex` || provider === `kimi` || provider === `gemini`) {
        return translatorAccounts.value[provider].length > 0;
    }
    if (provider === `grok`) {
        return accountsOf(provider).length > 0 || translatorAccounts.value.grok.length > 0;
    }
    // A configured endpoint is runnable by existing: whatever it needs to authenticate was configured with
    // it, so there is no second connection step the way there is for an account-backed provider.
    return accountsOf(provider).length > 0 || isAcp(provider) || isEndpoint(provider);
};

export const accessStateFor = (provider: AgentProvider): ProviderAccessState => ({
    ready: providerReady(provider),
    access: accessFor(provider),
    needsReauth: accountsOf(provider).some((account) => account.needsReauth === true),
});

// How a locked provider states its price in one chip. `free` leads with the word that changes a decision — a
// user who has connected nothing should be able to see, without connecting anything, that one of these rows
// costs nothing; the others name what they'd have to already pay for.
const KIND_BADGE: Record<AccessKind, (requirement: string) => string> = {
    free: (requirement) => `Free · ${requirement}`,
    subscription: (requirement) => `Needs ${requirement}`,
    key: (requirement) => `Needs ${requirement}`,
};

// The chip a provider's section header shows: nothing once it's connected (a usable provider should look like
// the plain default, not like a state), else its requirement.
export const accessBadge = (provider: AgentProvider): string | undefined => {
    const state = accessStateFor(provider);
    if (state.ready || state.access === undefined) {
        return undefined;
    }
    return KIND_BADGE[state.access.kind](state.access.requirement);
};

// The connect gate's one-line pitch, and the label on the button that resolves it. Grok is the one provider whose
// requirement depends on the harness: its native runtime takes an xAI account, but routed under Claude Code it
// rides the same SuperGrok subscription the translator holds.
export const connectPitch = (provider: AgentProvider, harness: AgentHarness): { copy: string; action: string } | undefined => {
    const access = accessFor(provider);
    if (access === undefined) {
        return undefined;
    }
    const runs = provider === `grok` && harness === `claude-code` ? `${access.runs} under Claude Code` : access.runs;
    return { copy: `Connect your ${access.requirement} to run ${runs}.`, action: `Connect ${access.requirement}` };
};
