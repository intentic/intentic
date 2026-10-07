import { Latest, pollFor } from "@intentic/base/async";
import { sandboxRef, sandboxScopeGuard, sandboxValue } from "@intentic/extension-api";
import { computed } from "vue";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import {
    type AgentProvider,
    type KeyedProvider,
    type LoginFlow,
    type NativeProvider,
    type OauthAccount,
    providerLabel,
    providerSpec,
    type SignInCatcher,
} from "@intentic/sandbox-contract";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { hasSignIn } from "../session/access";
import { active } from "../tabs/useChat-tabs";
import { loadProviderModels } from "../models/useChat-catalog";
import {
    accountBusy,
    accountsOf,
    addAccount,
    error,
    managedProvider,
    refreshAccounts,
    refreshTranslatorAccounts,
} from "../accounts/useChat-accounts";
import { translatorAccounts } from "../accounts/providerAccounts";
import { orRefusal, SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { type ProcedureOutput, sandboxRpc } from "../../../client/sandbox/sandboxRpc";

// In-flight subscription login, identified by the translator's own attempt state.
// `catchers` are the owner's devices and browsers watching where a redirect lands, so it finishes without the paste;
// empty for a sandbox (or an older daemon) with nobody watching.
export const translatorConnectFlow = sandboxRef<
    { provider: KeyedProvider; url: string; code: string; state: string; flow: "device" | "redirect"; catchers: readonly SignInCatcher[] } | undefined
>(() => undefined);

// Whether the reader has actually been handed to the provider's page this handshake. A paste sign-in is two
// turns — ours to send them, theirs to come back with the grant — and a live flow alone cannot tell them apart:
// without this, a card that nobody has acted on still claims to be signing in.
export const connectSent = sandboxRef(() => false);

// The last sign-in that ended without connecting anything, and the sentence saying why: what the chat's strip and the
// connect view show until the reader tries again or dismisses it. Without it a sign-in that expired, was refused or
// never started simply vanished, and the reader was left with a tile that looked picked and nothing else.
export const signInFailure = sandboxRef<{ readonly provider: AgentProvider; readonly message: string } | undefined>(() => undefined);

// Ends an attempt as failed: `error` for the surfaces that read the store's one error line, the record for the ones that
// say which provider it was.
const failSignIn = (provider: AgentProvider, message: string): void => {
    error.value = message;
    signInFailure.value = { provider, message };
};

export const dismissSignInFailure = (): void => {
    signInFailure.value = undefined;
};

// The last sign-in that connected an account, stamped so a second landing of the same provider still reads as news. Said
// by the paths that saw an account arrive, never inferred from a panel going away: a Cancel pressed in the chat's strip
// takes the panel down too, and a view that read that as success announced a connection nobody made.
export const signInLanded = sandboxRef<{ readonly provider: AgentProvider; readonly at: number } | undefined>(() => undefined);
const landSignIn = (provider: AgentProvider): void => {
    signInLanded.value = { provider, at: Date.now() };
};

// Routed row key, namespaced away from the provider id: native and translator accounts of the same provider
// are separate connections. `name` picks one subscription; omitted, the provider's sign-in.
export const translatorKey = (target: AgentProvider, name?: string): string => `translator:${target}${name === undefined ? `` : `:${name}`}`;
// How often a sign-in's poll asks whether it landed.
const SIGN_IN_POLL_MS = 3_000;

// The poll behind a subscription sign-in, one attempt at a time; a switch abandons it with the sandbox it was connecting.
// Aborting it cancels the status read in flight too, so an abandoned attempt can neither land nor fail on screen.
const translatorPoll = sandboxValue(
    () => new Latest(),
    (poll) => poll.abort(),
);

// Takes down a subscription sign-in and the poll behind it.
const settleTranslator = (): void => {
    translatorPoll.value.abort();
    translatorConnectFlow.value = undefined;
    connectSent.value = false;
};

// Provider's own account label for the sign-in-expired sentence, not a hardcoded default.
const translatorProviderLabel = (target: KeyedProvider): string => providerSpec(target)?.accountLabel ?? target;

// Polls this exact attempt until it lands, fails or expires: reconnecting an existing identity replaces its credential
// without increasing the account count.
const pollTranslator = async (target: KeyedProvider, state: string, until: number): Promise<void> => {
    const signal = translatorPoll.value.next();
    const outcome = await pollFor(
        async () => {
            const result = await sandboxRpc.translator.status({ provider: target, state }, { signal });
            return result.status === `wait` ? undefined : result;
        },
        // A failed read is a blip (sandbox or translator); the handshake asks again, bounded by its deadline.
        { intervalMs: SIGN_IN_POLL_MS, until, signal, delayFirst: true, retryOnError: true },
    );
    if (outcome.kind === `aborted`) {
        return;
    }
    if (outcome.kind === `expired`) {
        failSignIn(target, t(`chat.chatConnect.signInExpired`, { provider: translatorProviderLabel(target) }));
        settleTranslator();
        return;
    }
    if (outcome.value.status === `error`) {
        settleTranslator();
        failSignIn(target, t(`chat.chatConnect.signInFailed`, { provider: translatorProviderLabel(target), reason: outcome.value.error }));
        return;
    }
    await refreshTranslatorAccounts();
    if (!signal.aborted) {
        settleTranslator();
        error.value = null;
        landSignIn(target);
    }
};

// Starts a subscription login for a routed provider; returns a sign-in URL and, for some providers, a
// one-time code. One sign-in at a time, of either mechanism: a new connect supersedes any prior one, and does so up
// front, so a start that fails leaves nothing behind rather than the old panel with its poll already stopped.
export const connectTranslator = async (target: KeyedProvider): Promise<void> => {
    if (accountBusy.value !== undefined) {
        return;
    }
    cancelConnect();
    settleTranslator();
    accountBusy.value = translatorKey(target);
    error.value = null;
    signInFailure.value = undefined;
    // A sign-in started in the sandbox the scope has since left belongs to that sandbox's card, not this one's.
    const current = sandboxScopeGuard();
    try {
        const started = await sandboxRpc.translator.connect({ provider: target });
        if (!current()) {
            return;
        }
        translatorConnectFlow.value = { provider: target, ...started, catchers: started.catchers ?? [] };
        void pollTranslator(target, started.state, Date.now() + CODEX_POLL_DEADLINE_MS);
    } catch (caught) {
        failSignIn(target, messageOr(caught, t(`chat.chatConnect.subscriptionNotStarted`)));
    } finally {
        accountBusy.value = undefined;
    }
};

// Finishes a redirect login with the URL the provider sent the browser to (Google's loopback address isn't
// reachable, so the user pastes it). A 2xx is the daemon's verdict that the credential it wrote can serve a turn,
// so the sign-in comes down here rather than staying up until a poll tick notices. Answers whether it landed.
export const completeTranslator = async (redirectUrl: string): Promise<boolean> => {
    const flow = translatorConnectFlow.value;
    if (flow === undefined || flow.flow !== `redirect`) {
        return false;
    }
    accountBusy.value = translatorKey(flow.provider);
    error.value = null;
    try {
        await sandboxRpc.translator.complete({ provider: flow.provider, redirectUrl: redirectUrl.trim(), state: flow.state });
        await refreshTranslatorAccounts();
        // The row is the proof the account landed: an account read that didn't answer (refreshTranslatorAccounts
        // swallows its own failure) leaves the panel and its poll up rather than claiming a connection nothing shows.
        if (translatorAccounts.value[flow.provider].length === 0) {
            return false;
        }
        // Only if this is still the same attempt: a restarted sign-in owns the panel now.
        if (translatorConnectFlow.value === flow) {
            settleTranslator();
            landSignIn(flow.provider);
        }
        // Catalog is only discoverable with a credential, so load it now rather than at the next reselect.
        void loadProviderModels(flow.provider);
        return true;
    } catch (caught) {
        error.value = messageOr(caught, t(`chat.chatConnect.linkNotCompleted`));
        return false;
    } finally {
        accountBusy.value = undefined;
    }
};

// Drops one of the provider's connected accounts, addressed by its translator auth-file name.
export const disconnectTranslator = async (target: KeyedProvider, name: string): Promise<void> => {
    accountBusy.value = translatorKey(target, name);
    try {
        // A refusal needs no answer of its own: the list re-read below is what says whether the account went.
        await orRefusal(sandboxRpc.translator.disconnect({ provider: target, name }));
        if (translatorConnectFlow.value?.provider === target) {
            settleTranslator();
        }
        await refreshTranslatorAccounts();
    } finally {
        accountBusy.value = undefined;
    }
};

// Abandons an in-flight subscription login without connecting anything.
export const cancelTranslatorConnect = (): void => {
    settleTranslator();
};

// In-flight native sign-in, scoped to the provider that started it so tab-switching can't cross-contaminate
// rows. `flow` says how it ends; `handshake` is an opaque attempt id, not a credential.
interface NativeConnectFlow {
    readonly provider: AgentProvider;
    readonly url: string;
    readonly code: string;
    readonly state: string;
    readonly flow: LoginFlow;
    readonly variant: string;
    readonly handshake: string;
    // The owner's devices and browsers watching where this sign-in's redirect lands; empty when nobody is.
    readonly catchers: readonly SignInCatcher[];
    // The grant came back and was accepted, but the credential behind it is still being minted: there is nothing
    // left to ask the user for, and nothing to show yet either.
    readonly redeemed: boolean;
}
export const nativeConnectFlow = sandboxRef<NativeConnectFlow | undefined>(() => undefined);
// Display label typed for the account being connected; blank lets the daemon derive one.
export const connectLabel = sandboxRef(() => ``);

// Device-code sign-in expires after 15 minutes; stop polling past it.
const CODEX_POLL_DEADLINE_MS = 15 * 60 * 1000;
// The poll behind a native sign-in, as translatorPoll is for a subscription's.
const nativePoll = sandboxValue(
    () => new Latest(),
    (poll) => poll.abort(),
);

// Stops the poll and clears the connect UI state only; for a sign-in that finished, there's nothing else to abandon.
const settleConnect = (): void => {
    nativePoll.value.abort();
    nativeConnectFlow.value = undefined;
    connectLabel.value = ``;
    connectSent.value = false;
};

// Abandons an in-progress handshake, safe to call repeatedly. Also tells the daemon (fire-and-forget): for
// every shape but paste, the poll runs there, not in this tab.
export const cancelConnect = (): void => {
    const flow = nativeConnectFlow.value;
    if (flow !== undefined) {
        void sandboxRpc.accounts.cancel({ provider: flow.provider as NativeProvider, handshake: flow.handshake }).catch((cause: unknown) => {
            console.warn("Could not cancel the sign-in handshake", cause);
            return undefined;
        });
    }
    settleConnect();
};

// The account list as a sign-in found it, so a poll can tell this sign-in landing from accounts that were already there.
// Without it, "Add another account" on a provider that already held one read as connected on the first tick: the list
// was not empty, so the panel came down and "Connected" was announced over a sign-in nobody had finished.
export interface AccountsBefore {
    readonly connectedAt: ReadonlyMap<string, number>;
    // Accounts that could not serve until somebody signed in again: a reconnect lands on the same id (the daemon's one
    // connect rule), so for one of those the sign-in landing is the account recovering, not a new row.
    readonly stale: ReadonlySet<string>;
}
const unservable = (account: OauthAccount): boolean =>
    account.needsReauth === true || (account.state?.kind === `blocked` && account.state.fix === `reconnect`);
export const accountsBefore = (accounts: readonly OauthAccount[]): AccountsBefore => ({
    connectedAt: new Map(accounts.map((account) => [account.id, account.connectedAt])),
    stale: new Set(accounts.filter(unservable).map((account) => account.id)),
});
// Landed: an account that was not there, one connected again since, or one that needed a new sign-in and now serves.
export const landedSince = (before: AccountsBefore, now: readonly OauthAccount[]): boolean =>
    now.some(
        (account) =>
            !before.connectedAt.has(account.id) ||
            before.connectedAt.get(account.id) !== account.connectedAt ||
            (before.stale.has(account.id) && !unservable(account)),
    );

// Ends a native sign-in's poll that ran out of time, as the daemon's own `expiresAt` says the attempt has.
const expireNative = (target: AgentProvider): void => {
    cancelConnect();
    failSignIn(target, t(`chat.chatConnect.signInExpired`, { provider: providerLabel(target) }));
};

// Polls a sign-in that finishes out of band by the account list: done once an account landed since the sign-in started
// (paste finishes via completeConnect instead). Redeeming a grant re-stamps the same attempt without touching this poll,
// which the credential still has to land through; only a settle, a cancel or a new start ends it.
const pollNativeList = async (target: AgentProvider, until: number, before: AccountsBefore): Promise<void> => {
    const signal = nativePoll.value.next();
    const outcome = await pollFor(async () => (landedSince(before, await refreshAccounts(target)) ? true : undefined), {
        intervalMs: SIGN_IN_POLL_MS,
        until,
        signal,
        delayFirst: true,
        // A failed read is a blip (a sandbox restart); the handshake asks again, bounded by its deadline.
        retryOnError: true,
    });
    if (outcome.kind === `expired`) {
        expireNative(target);
        return;
    }
    if (outcome.kind === `found`) {
        settleConnect();
        error.value = null;
        landSignIn(target);
        // Load the catalog now so the picker is populated immediately, not after the next reselect.
        void loadProviderModels(target);
    }
};

// Polls a sign-in the daemon keeps a record of (every one somebody of the owner's is watching the landing for): reads the
// attempt itself, so adding a second account is not mistaken for done because the first exists.
const pollNativeStatus = async (target: AgentProvider, handshake: string, until: number): Promise<void> => {
    const signal = nativePoll.value.next();
    const outcome = await pollFor(
        async () => {
            // SAFETY: a native flow is only ever started by startConnect, through the accounts door, for a native provider.
            const result = await sandboxRpc.accounts.status({ provider: target as NativeProvider, handshake }, { signal });
            return result.status === `wait` ? undefined : result;
        },
        // A failed read is a blip (sandbox or translator); the handshake asks again, bounded by its deadline.
        { intervalMs: SIGN_IN_POLL_MS, until, signal, delayFirst: true, retryOnError: true },
    );
    if (outcome.kind === `aborted`) {
        return;
    }
    if (outcome.kind === `expired`) {
        expireNative(target);
        return;
    }
    if (outcome.value.status === `error`) {
        settleConnect();
        failSignIn(target, t(`chat.chatConnect.signInFailed`, { provider: providerLabel(target), reason: outcome.value.error }));
        return;
    }
    if (outcome.value.account !== undefined) {
        addAccount(target, outcome.value.account);
    }
    await refreshAccounts(target);
    if (!signal.aborted) {
        settleConnect();
        error.value = null;
        landSignIn(target);
    }
    void loadProviderModels(target);
};

// Step 1 of a native connect: Claude mints an authorize URL + PKCE challenge; Grok mints a device code and
// starts its own poll. Routed subscriptions (including Kimi Code) use connectTranslator above.

// Only started by the row's own Connect button, never a provider switch. `accountBusy` holds the provider for
// the round trip, so the sign-in replaces the button rather than appearing beside a still-clickable one.
export const startConnect = async (variant?: string): Promise<void> => {
    const target = managedProvider.value;
    if (accountBusy.value !== undefined) {
        return;
    }
    // What was already here, read before anything changes it, so the poll below knows what landing looks like.
    const before = accountsBefore(accountsOf(target));
    // One sign-in at a time, of either mechanism (connectTranslator).
    cancelConnect();
    settleTranslator();
    error.value = null;
    signInFailure.value = undefined;
    // Held busy for the whole start so the button doesn't flash back to "Connect" before the flow lands.
    accountBusy.value = target;
    // As for a subscription: a start that lands after a switch is the outgoing sandbox's handshake.
    const current = sandboxScopeGuard();
    try {
        let body: ProcedureOutput<`accounts.start`> | SandboxHttpError;
        try {
            // Which estate to sign in to (Z.ai sells several); absent takes the provider's default.
            body = await orRefusal(sandboxRpc.accounts.start({ provider: target as NativeProvider, variant }));
        } catch (err) {
            failSignIn(target, messageOr(err, t(`chat.chatConnect.connectionNotStarted`, { provider: providerLabel(target) })));
            return;
        }
        if (!current()) {
            return;
        }
        if (body instanceof SandboxHttpError) {
            failSignIn(target, body.message);
            return;
        }
        nativeConnectFlow.value = {
            provider: target,
            url: body.url,
            code: body.code,
            state: body.state,
            flow: body.flow,
            variant: body.variant,
            handshake: body.handshake,
            catchers: body.catchers ?? [],
            redeemed: false,
        };
        // A watched sign-in can finish with nobody touching this tab, so it polls the attempt itself. Otherwise
        // paste-back never polls, and every other shape watches the account list. Both until the daemon's own
        // `expiresAt`, not a local deadline, since that's the attempt that actually expires.
        if ((body.catchers ?? []).length > 0) {
            void pollNativeStatus(target, body.handshake, body.expiresAt);
        } else if (body.flow !== `paste`) {
            void pollNativeList(target, body.expiresAt, before);
        }
    } finally {
        accountBusy.value = undefined;
    }
};

// The one sign-in in flight, whichever mechanism holds it. Every surface that reports one (the chat's strip, the connect
// view) reads it here, so they cannot disagree about which provider is waiting.
export const liveSignIn = computed<{ readonly kind: `native` | `routed`; readonly provider: AgentProvider } | undefined>(() => {
    if (nativeConnectFlow.value !== undefined) {
        return { kind: `native`, provider: nativeConnectFlow.value.provider };
    }
    if (translatorConnectFlow.value !== undefined) {
        return { kind: `routed`, provider: translatorConnectFlow.value.provider };
    }
    return undefined;
});

// Abandons whichever sign-in is in flight, from anywhere that shows one.
export const cancelSignIn = (): void => {
    cancelConnect();
    settleTranslator();
};

// Points the account card at the active conversation's provider on open; skipped mid-handshake so switching
// rows can't hide a code being approved. Torn down only by cancelConnect, the deadline, or a fresh start.
export const showActiveProvider = (): void => {
    if (nativeConnectFlow.value !== undefined || translatorConnectFlow.value !== undefined) {
        return;
    }
    const target = active.value.selection.provider.value;
    /* Connection changes apply only to providers managed by the card. */
    if (!hasSignIn(target)) {
        return;
    }
    managedProvider.value = target;
};

// Step 2 for a sign-in needing something brought back (a pasted code or redirect URL); device flows finish via the poll
// instead. Settles only when the response includes an account; an accepted redirect alone means keep polling.
export const completeConnect = async (pasted: string): Promise<boolean> => {
    const flow = nativeConnectFlow.value;
    if (flow === undefined || flow.flow === `device`) {
        error.value = t(`chat.chatConnect.startFirst`);
        return false;
    }
    accountBusy.value = flow.provider;
    try {
        const body =
            flow.flow === `redirect`
                ? { handshake: flow.handshake, redirectUrl: pasted.trim() }
                : { handshake: flow.handshake, code: pasted.trim(), label: connectLabel.value.trim() || undefined };
        let completed: ProcedureOutput<`accounts.complete`> | SandboxHttpError;
        try {
            completed = await orRefusal(sandboxRpc.accounts.complete({ provider: flow.provider as NativeProvider, ...body }));
        } catch (err) {
            error.value = messageOr(err, t(`chat.chatConnect.signInNotFinished`, { provider: providerLabel(flow.provider) }));
            return false;
        }
        if (completed instanceof SandboxHttpError) {
            // Daemon's own message tells apart an expired attempt, a refused code, a bad state, or address.
            error.value = completed.message;
            return false;
        }
        const { account } = completed;
        error.value = null;
        // Accepted, with the credential still to be minted (every native redirect: the account lands through the
        // poll, not this response). Marked on the attempt so the panel waits instead of asking for the address again.
        if (account === undefined) {
            nativeConnectFlow.value = { ...flow, redeemed: true };
            return true;
        }
        addAccount(flow.provider, account);
        settleConnect();
        landSignIn(flow.provider);
        // Catalog may only now be discoverable, since some providers need a credential to list models.
        void loadProviderModels(flow.provider);
        return true;
    } finally {
        accountBusy.value = undefined;
    }
};

// Singleton per window: a hot update re-running this module would mint a second sign-in flow beside the one
// still in use.
reloadOnHotUpdate(import.meta);
