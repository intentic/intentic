import { Latest, pollFor } from "@intentic/base/async";
import { sandboxRef, sandboxScopeGuard, sandboxValue } from "@intentic/extension-api";
import { computed, watch } from "vue";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { KeyedProvider } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import type { LoginFlow, OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { loopDoors, providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { type NativeProvider, providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import type { SignInCatcher } from "@intentic/sandbox-contract/schemas/loopback-catch";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { hasSignIn } from "../../providers/access";
import { active } from "../tabs/useChat-tabs";
import { loadProviderModels } from "../accounts/useChat-catalog";
import {
    accountBusy,
    accountsOf,
    addAccount,
    error,
    managedProvider,
    refreshAccounts,
    refreshTranslatorAccounts,
} from "../accounts/useChat-accounts";
import { translatorAccounts } from "../../providers/providerAccounts";
import { accountFacts, accountState } from "../../providers/usageStatus";
import { orRefusal, SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { type ProcedureOutput, sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import type { SignInTab } from "./signInTab";
import { keepWatchers } from "./signInWatchers";
import {
    accountArrival,
    failSignIn,
    landSignIn,
    markTrip,
    resetTrip,
    type SignInArrival,
    signInFailure,
    translatorArrival,
} from "./signInOutcome";

// The outcome records live beside this store (signInOutcome.ts); every surface reads them through useChat as before.
export { dismissSignInFailure, signInFailure, signInLanded } from "./signInOutcome";

// In-flight subscription login, identified by the translator's own attempt state.
// `catchers` are the owner's devices and browsers watching where a redirect lands, so it finishes without the paste;
// empty for a sandbox (or an older daemon) with nobody watching.
// `expiresAt` is when the poll behind it gives up (the translator names no deadline of its own), so the card can count down
// to it rather than a timeout arriving out of nowhere.
export const translatorConnectFlow = sandboxRef<
    | {
          provider: KeyedProvider;
          url: string;
          code: string;
          state: string;
          flow: "device" | "redirect";
          catchers: readonly SignInCatcher[];
          expiresAt: number;
      }
    | undefined
>(() => undefined);

// Whether the reader has actually been handed to the provider's page this handshake. A paste sign-in is two
// turns — ours to send them, theirs to come back with the grant — and a live flow alone cannot tell them apart:
// without this, a card that nobody has acted on still claims to be signing in.
export const connectSent = sandboxRef(() => false);
// Whether a device sign-in's code went to the clipboard with the trip that the press made (signInTab.ts), so the panel
// says it is there instead of asking for a copy that already happened.
export const connectCodeCopied = sandboxRef(() => false);
// A trip to the provider's page, remembered past the attempt for the landing's "close the tab" (signInOutcome.ts).
watch(connectSent, (sent) => {
    if (sent) {
        markTrip();
    }
});

// The press that started this sign-in held a tab for it (signInTab.ts): the reader goes to the provider's page now, and
// the panel opens on its second step. `still` says the attempt is the one on screen, since the copy can outlast it.
const handOff = (tab: SignInTab | undefined, url: string, code: string, still: () => boolean): void => {
    if (tab === undefined) {
        return;
    }
    connectSent.value = true;
    void tab.send(url, code).then(({ sent, copied }) => {
        if (!still()) {
            return;
        }
        // A held tab closed before the address came back went nowhere: the panel's own Open is the way, as without one.
        connectSent.value = sent;
        connectCodeCopied.value = copied;
    });
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

// The subscriptions the translator held when the running sign-in started, so a pasted landing can tell a new one from the
// same one signed in again (translatorArrival).
let translatorBefore: ReadonlySet<string> = new Set();

// Takes down a subscription sign-in and the poll behind it.
const settleTranslator = (): void => {
    translatorPoll.value.abort();
    translatorConnectFlow.value = undefined;
    connectSent.value = false;
    connectCodeCopied.value = false;
};

// Provider's own account label for the sign-in-expired sentence, not a hardcoded default.
const translatorProviderLabel = (target: KeyedProvider): string => providerSpec(target)?.accountLabel ?? target;

// Polls this exact attempt until it lands, fails or expires: reconnecting an existing identity replaces its credential
// without increasing the account count.
const pollTranslator = async (target: KeyedProvider, state: string, until: number, before: ReadonlySet<string>): Promise<void> => {
    const signal = translatorPoll.value.next();
    const outcome = await pollFor(
        async () => {
            const result = await sandboxRpc.translator.status({ provider: target, state }, { signal });
            if (result.status === `wait`) {
                keepWatchers(result.catchers, translatorConnectFlow, (flow) => flow.state === state);
                return undefined;
            }
            return result;
        },
        // A failed read is a blip (sandbox or translator); the handshake asks again, bounded by its deadline.
        { intervalMs: SIGN_IN_POLL_MS, until, signal, delayFirst: true, retryOnError: true },
    );
    if (outcome.kind === `aborted`) {
        return;
    }
    if (outcome.kind === `expired`) {
        failSignIn(target, t(`chat.chatConnect.signInExpired`, { provider: translatorProviderLabel(target) }), `expired`);
        settleTranslator();
        return;
    }
    if (outcome.value.status === `error`) {
        settleTranslator();
        failSignIn(target, t(`chat.chatConnect.signInFailed`, { provider: translatorProviderLabel(target), reason: outcome.value.error }), `refused`);
        return;
    }
    await refreshTranslatorAccounts();
    if (!signal.aborted) {
        settleTranslator();
        error.value = null;
        landSignIn(target, translatorArrival(target, before));
    }
};

// Starts a subscription login for a routed provider; returns a sign-in URL and, for some providers, a
// one-time code. One sign-in at a time, of either mechanism: a new connect supersedes any prior one, and does so up
// front, so a start that fails leaves nothing behind rather than the old panel with its poll already stopped. `tab` is
// the one the press held, sent on to the page once there is one (the caller releases it when nothing was).
export const connectTranslator = async (target: KeyedProvider, tab?: SignInTab): Promise<void> => {
    if (accountBusy.value !== undefined) {
        return;
    }
    cancelConnect();
    settleTranslator();
    accountBusy.value = translatorKey(target);
    error.value = null;
    signInFailure.value = undefined;
    resetTrip();
    // A sign-in started in the sandbox the scope has since left belongs to that sandbox's card, not this one's.
    const current = sandboxScopeGuard();
    try {
        const started = await sandboxRpc.translator.connect({ provider: target });
        if (!current()) {
            return;
        }
        const expiresAt = Date.now() + CODEX_POLL_DEADLINE_MS;
        const before = new Set((translatorAccounts.value[target] ?? []).map((account) => account.name));
        translatorBefore = before;
        translatorConnectFlow.value = { provider: target, ...started, catchers: started.catchers ?? [], expiresAt };
        // By the attempt's own state, as the poll reads it: the ref hands back a proxy, never the object put in.
        handOff(tab, started.url, started.code, () => translatorConnectFlow.value?.state === started.state);
        void pollTranslator(target, started.state, expiresAt, before);
    } catch (caught) {
        failSignIn(target, messageOr(caught, t(`chat.chatConnect.subscriptionNotStarted`)), `unstarted`);
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
            landSignIn(flow.provider, translatorArrival(flow.provider, translatorBefore));
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
    // When the daemon stops answering this attempt, so the card can count down to it.
    readonly expiresAt: number;
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
    connectCodeCopied.value = false;
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
    readonly provider: AgentProvider;
    readonly connectedAt: ReadonlyMap<string, number>;
    // Accounts that could not serve until somebody signed in again: a reconnect lands on the same id (the daemon's one
    // connect rule), so for one of those the sign-in landing is the account recovering, not a new row.
    readonly stale: ReadonlySet<string>;
}
// By the one rule every surface judges an account by (accountState), so a refused sign-in on file counts as one too.
const unservable = (provider: AgentProvider, account: OauthAccount): boolean => {
    const state = accountState(provider, accountFacts(account));
    return state.kind === `blocked` && state.fix === `reconnect`;
};
export const accountsBefore = (provider: AgentProvider, accounts: readonly OauthAccount[]): AccountsBefore => ({
    provider,
    connectedAt: new Map(accounts.map((account) => [account.id, account.connectedAt])),
    stale: new Set(accounts.filter((account) => unservable(provider, account)).map((account) => account.id)),
});
// Landed: an account that was not there, one connected again since, or one that needed a new sign-in and now serves.
// The account itself, so the landing can say who signed in.
const landedAccount = (before: AccountsBefore, now: readonly OauthAccount[]): OauthAccount | undefined =>
    now.find(
        (account) =>
            !before.connectedAt.has(account.id) ||
            before.connectedAt.get(account.id) !== account.connectedAt ||
            (before.stale.has(account.id) && !unservable(before.provider, account)),
    );

// The account list as the running native sign-in found it, for the paths that land it without a poll of their own (a
// pasted code's answer), so they too can tell a new account from one signing in again.
let nativeBefore: AccountsBefore | undefined;
const arrivalOf = (account: OauthAccount | undefined): SignInArrival =>
    account === undefined || nativeBefore === undefined ? {} : accountArrival(account, nativeBefore.connectedAt);

// Ends a native sign-in's poll that ran out of time, as the daemon's own `expiresAt` says the attempt has.
const expireNative = (target: AgentProvider): void => {
    cancelConnect();
    failSignIn(target, t(`chat.chatConnect.signInExpired`, { provider: providerLabel(target) }), `expired`);
};

// Polls a sign-in that finishes out of band by the account list: done once an account landed since the sign-in started
// (paste finishes via completeConnect instead). Redeeming a grant re-stamps the same attempt without touching this poll,
// which the credential still has to land through; only a settle, a cancel or a new start ends it.
const pollNativeList = async (target: AgentProvider, until: number, before: AccountsBefore): Promise<void> => {
    const signal = nativePoll.value.next();
    const outcome = await pollFor(async () => landedAccount(before, await refreshAccounts(target)), {
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
        landSignIn(target, accountArrival(outcome.value, before.connectedAt));
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
            if (result.status === `wait`) {
                keepWatchers(result.catchers, nativeConnectFlow, (flow) => flow.handshake === handshake);
                return undefined;
            }
            return result;
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
        failSignIn(target, t(`chat.chatConnect.signInFailed`, { provider: providerLabel(target), reason: outcome.value.error }), `refused`);
        return;
    }
    const { account } = outcome.value;
    if (account !== undefined) {
        addAccount(target, account);
    }
    const arrival = arrivalOf(account);
    await refreshAccounts(target);
    if (!signal.aborted) {
        settleConnect();
        error.value = null;
        landSignIn(target, arrival);
    }
    void loadProviderModels(target);
};

// Step 1 of a native connect: Claude mints an authorize URL + PKCE challenge; Grok mints a device code and
// starts its own poll. Routed subscriptions (including Kimi Code) use connectTranslator above.

// Only started by the row's own Connect button, never a provider switch. `accountBusy` holds the provider for
// the round trip, so the sign-in replaces the button rather than appearing beside a still-clickable one. `tab` is the
// one that press held (connectTranslator).
export const startConnect = async (variant?: string, tab?: SignInTab): Promise<void> => {
    const target = managedProvider.value;
    if (accountBusy.value !== undefined) {
        return;
    }
    // What was already here, read before anything changes it, so the poll below knows what landing looks like.
    const before = accountsBefore(target, accountsOf(target));
    // One sign-in at a time, of either mechanism (connectTranslator).
    cancelConnect();
    settleTranslator();
    error.value = null;
    signInFailure.value = undefined;
    nativeBefore = before;
    resetTrip();
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
            failSignIn(target, messageOr(err, t(`chat.chatConnect.connectionNotStarted`, { provider: providerLabel(target) })), `unstarted`);
            return;
        }
        if (!current()) {
            return;
        }
        if (body instanceof SandboxHttpError) {
            failSignIn(target, body.message, `unstarted`);
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
            expiresAt: body.expiresAt,
        };
        // Read by attempt, not by object: a redeemed grant re-stamps the same attempt as a new object.
        handOff(tab, body.url, body.code, () => nativeConnectFlow.value?.handshake === body.handshake);
        // A watched sign-in can finish with nobody touching this tab, so it polls the attempt itself, and so does a loop's
        // own CLI sign-in (Grok Build, Kimi CLI), whose CLI can be turned away by the vendor after the code was shown:
        // only the attempt says so. Otherwise paste-back never polls, and every other shape watches the account list.
        // All until the daemon's own `expiresAt`, not a local deadline, since that's the attempt that actually expires.
        if ((body.catchers ?? []).length > 0 || loopDoors(target).some((door) => door.door === body.variant)) {
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
        const arrival = arrivalOf(account);
        addAccount(flow.provider, account);
        settleConnect();
        landSignIn(flow.provider, arrival);
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
