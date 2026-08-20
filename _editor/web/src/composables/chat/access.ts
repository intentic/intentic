import {
    accessFor,
    type AccessKind,
    type AgentHarness,
    type AgentProvider,
    FREE_PROVIDERS,
    isTrialProvider,
    PROVIDER_ACCESS,
    type ProviderAccess,
    providerLabel,
} from "@intentic/sandbox-contract";
import { providerAccounts, translatorAccounts } from "./providerAccounts";
import { acpProviders, endpointProviders, trialStatus } from "./providerCatalog";

/* CAN THIS PROVIDER ACTUALLY RUN, and what does it take to unlock it, one rule, read by every surface that
 * offers a provider (the model picker's rows and rail, the connect gate above the composer, the account panel).
 * It existed only inside useChat before, as the composer's own gate, which is why the picker listed Kimi models
 * to a user with no Kimi Code subscription exactly as it listed the ones they could send to: a catalog is deliberately
 * never empty daemon-side (every provider serves a seed floor so a turn always resolves a model), so "has rows"
 * says nothing at all about "can send".
 *
 * The requirement differs per provider and that difference is the useful part, a Google sign-in costs nothing
 * and a ChatGPT subscription costs money, so the picker states which, rather than flattening both to "locked". */

export interface ProviderAccessState {
    // Whether a turn on this provider can be sent right now.
    readonly ready: boolean;
    // Absent for an ACP agent and for a model endpoint, both carry their own credentials, so each is ready by
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
// the translator, everything else through a daemon-stored account. Harness-independent on purpose, this answers
// "is this provider usable at all", which is what a model row needs; `providerReadyOn` below narrows it to the
// one harness the active conversation is actually set to, and IS the composer's gate.
export const providerReady = (provider: AgentProvider): boolean => {
    if (provider === `codex` || provider === `kimi` || provider === `gemini`) {
        return translatorAccounts.value[provider].length > 0;
    }
    if (provider === `grok`) {
        return accountsOf(provider).length > 0 || translatorAccounts.value.grok.length > 0;
    }
    /* THE TRIAL IS THE ONE ENDPOINT WHOSE EXISTENCE IS NOT ITS READINESS. Every other endpoint carries a
     * credential that works until the user changes it; this one carries a daily meter, and a spent meter cannot
     * serve a turn, the platform answers a 429 naming the reset (trial.routes).
     *
     * Reading the allowance here is what makes the whole product hand the screen back at the right moment: the
     * composer closes, the connect offer returns to the board and the gate, and the picker's row goes locked
     * beside a badge that already says "used up today". The alternative is a live composer that swallows a
     * sentence and answers with an error, which is the shape this gate exists to prevent. */
    if (isTrialProvider(provider)) {
        return isEndpoint(provider) && trialStatus.value.available && trialStatus.value.remaining > 0;
    }
    // A configured endpoint is runnable by existing: whatever it needs to authenticate was configured with
    // it, so there is no second connection step the way there is for an account-backed provider.
    return accountsOf(provider).length > 0 || isAcp(provider) || isEndpoint(provider);
};

/* Whether a provider can serve THIS conversation, `providerReady` narrowed by the one axis it ignores.
 *
 * Grok is the only provider whose credential depends on the harness: its native runtime takes an xAI account,
 * and routed under Claude Code it rides the translator's SuperGrok subscription. So "you hold a SuperGrok
 * subscription" and "this native-Grok chat can send" are different answers, and any surface that offers to
 * SWITCH a conversation onto a provider needs the second one, a press that re-points the chat and leaves the
 * connect gate standing exactly where it was is the one press a user cannot learn anything from. */
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

// How a locked provider states its price in one chip. `free` leads with the word that changes a decision, a
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

/* The connect gate's one-line pitch, and the NAME of the button that resolves it. Grok is the one provider whose
 * requirement depends on the harness: its native runtime takes an xAI account, but routed under Claude Code it
 * rides the same SuperGrok subscription the translator holds.
 *
 * `action` is what a control SAYS ABOUT ITSELF rather than what it prints: in the gate it is the chip's hover
 * and its accessible name, because the chip's visible label is the provider's bare name and the row it sits in
 * is what makes that a connect offer, context a screen reader reading one button does not get, and a button
 * reading "Connect SuperGrok subscription" in a pane this narrow would have taken the row two lines to say. */
export const connectPitch = (provider: AgentProvider, harness: AgentHarness): { copy: string; action: string } | undefined => {
    const access = accessFor(provider);
    if (access === undefined) {
        return undefined;
    }
    const runs = provider === `grok` && harness === `claude-code` ? `${access.runs} under Claude Code` : access.runs;
    return { copy: `Connect your ${access.requirement} to run ${runs}.`, action: `Connect ${access.requirement}` };
};

/* THE TRIAL'S OWN CHIP, and why it is not `accessBadge`.
 *
 * The trial is an `endpoint` provider, and every endpoint answers `undefined` to accessFor, correctly, because
 * an endpoint carries its own credential and there is nothing to connect. That is exactly the shape the trial
 * wants (it is ready without connecting anything) and exactly the wrong chip: what a user needs to see on this
 * row is not a price but a REMAINING COUNT, and next to it no "Connect" button, because pressing one would be
 * pressing it for a provider that is already working.
 *
 * Undefined for every other provider, and for a trial the daemon has not confirmed, so a picker that has not
 * heard from the platform yet shows a plain row rather than promising an allowance that may not exist. */
export const trialBadge = (provider: AgentProvider): string | undefined => {
    if (!isTrialProvider(provider) || !trialStatus.value.available) {
        return undefined;
    }
    const { remaining } = trialStatus.value;
    return remaining > 0 ? `Free trial · ${remaining} left today` : `Free trial · used up today`;
};

// Whether the trial is spent, the point at which the row stops being an offer and becomes a signpost to the
// free Google sign-in, which is the next rung and has no daily cap.
export const trialExhausted = (provider: AgentProvider): boolean =>
    isTrialProvider(provider) && trialStatus.value.available && trialStatus.value.remaining <= 0;

export interface FreeOffer {
    readonly provider: AgentProvider;
    readonly headline: string;
    readonly copy: string;
    readonly action: string;
}

/* THE FREE WAY IN, phrased for the gate a user with nothing connected actually meets, and the reason it is a
 * separate helper from connectPitch rather than a nicer string inside it.
 *
 * connectPitch answers "what does the provider you are POINTED AT need", which is the right question once a
 * provider has been chosen and the wrong one before that: a user who has connected nothing has not chosen
 * anything, and the gate was answering for whichever provider happened to be selected, usually a paid one.
 * This answers "what can you do right now for free", which is the only question that changes their next minute.
 *
 * Every word is derived. The provider comes from FREE_PROVIDERS, the name from the provider's own label, the
 * sentence from the access table's own `runs`. Nothing about Google is written here, so a second free channel
 * would be offered without an edit, and a channel that stops being free stops being offered.
 *
 * Undefined means there is nothing free left to OFFER, the catalog has no free row, or the user already
 * connected the one it had. A gate still pitching "try free" to someone who has just done that is a gate
 * arguing with its own state, so the panel falls back to naming what the selected provider needs. */
export const freeOffer = (): FreeOffer | undefined => {
    const provider = FREE_PROVIDERS.find((candidate) => !providerReady(candidate));
    if (provider === undefined) {
        return undefined;
    }
    const label = providerLabel(provider);
    return {
        provider,
        headline: `Try free with ${label}`,
        copy: `No subscription needed — runs ${PROVIDER_ACCESS[provider].runs}.`,
        action: `Continue with ${label}`,
    };
};
