import { errorMessage } from "@intentic/ui/async";
import {
    type AgentProvider,
    type KeyedProvider,
    type LoginFlow,
    type LoginStart,
    type OauthAccount,
    providerLabel,
    providerSpec,
    type TranslatorStatus,
} from "@intentic/sandbox-contract";
import { ref } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { hasSignIn } from "../session/access";
import { active } from "../tabs/useChat-tabs";
import { loadProviderModels } from "../models/useChat-catalog";
import {
    accountBusy,
    addAccount,
    error,
    managedProvider,
    providerBase,
    refreshAccounts,
    refreshTranslatorAccounts,
} from "../accounts/useChat-accounts";
import { translatorAccounts } from "../accounts/providerAccounts";
import { sandboxError, sandboxJson, sandboxRequest } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";

// In-flight subscription login, identified by the translator's own attempt state.
export const translatorConnectFlow = ref<
    { provider: KeyedProvider; url: string; code: string; state: string; flow: "device" | "redirect" } | undefined
>(undefined);

// Whether the reader has actually been handed to the provider's page this handshake. A paste sign-in is two
// turns — ours to send them, theirs to come back with the grant — and a live flow alone cannot tell them apart:
// without this, a card that nobody has acted on still claims to be signing in.
export const connectSent = ref(false);

// Routed row key, namespaced away from the provider id: native and translator accounts of the same provider
// are separate connections. `name` picks one subscription; omitted, the provider's sign-in.
export const translatorKey = (target: AgentProvider, name?: string): string => `translator:${target}${name === undefined ? `` : `:${name}`}`;
let translatorPollTimer: ReturnType<typeof setTimeout> | undefined;

// Takes down a subscription sign-in and the poll behind it; the timer is cleared too, so a tick can't fire
// against an attempt that is already finished or abandoned.
const settleTranslator = (): void => {
    clearTimeout(translatorPollTimer);
    translatorConnectFlow.value = undefined;
    connectSent.value = false;
};

// Provider's own account label for the sign-in-expired sentence, not a hardcoded default.
const translatorProviderLabel = (target: KeyedProvider): string => providerSpec(target)?.accountLabel ?? target;

// Polls this exact attempt: reconnecting an existing identity replaces its credential without increasing the account count.
const pollTranslatorOnce = async (target: KeyedProvider, deadline: number): Promise<void> => {
    if (translatorConnectFlow.value?.provider !== target) {
        return;
    }
    if (Date.now() > deadline) {
        error.value = `The ${translatorProviderLabel(target)} sign-in expired: start the connection again.`;
        translatorConnectFlow.value = undefined;
        return;
    }
    const flow = translatorConnectFlow.value;
    if (flow?.provider !== target) {
        return;
    }
    try {
        const result = await sandboxJson<TranslatorStatus>(`/translator/${target}/connect?state=${encodeURIComponent(flow.state)}`);
        if (translatorConnectFlow.value !== flow) {
            return;
        }
        if (result.status === "ok") {
            await refreshTranslatorAccounts();
            if (translatorConnectFlow.value === flow) {
                translatorConnectFlow.value = undefined;
                error.value = null;
            }
            return;
        }
        if (result.status === "error") {
            translatorConnectFlow.value = undefined;
            error.value = `The ${translatorProviderLabel(target)} sign-in failed: ${result.error}`;
            return;
        }
    } catch {
        // Transient (sandbox or translator blip); keep polling until the deadline.
    }
    translatorPollTimer = setTimeout(() => void pollTranslatorOnce(target, deadline), 3_000);
};

// Starts a subscription login for a routed provider; returns a sign-in URL and, for some providers, a
// one-time code. One flow at a time: a new connect supersedes any prior.
export const connectTranslator = async (target: KeyedProvider): Promise<void> => {
    if (accountBusy.value !== undefined) {
        return;
    }
    accountBusy.value = translatorKey(target);
    error.value = null;
    connectSent.value = false;
    clearTimeout(translatorPollTimer);
    try {
        translatorConnectFlow.value = {
            provider: target,
            ...(await sandboxJson<{ url: string; code: string; state: string; flow: "device" | "redirect" }>(`/translator/${target}/connect`, {
                method: `POST`,
            })),
        };
        translatorPollTimer = setTimeout(() => void pollTranslatorOnce(target, Date.now() + CODEX_POLL_DEADLINE_MS), 3_000);
    } catch (caught) {
        error.value = errorMessage(caught, `Could not start the subscription connection: is your sandbox online?`);
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
        await sandboxJson(
            `/translator/${flow.provider}/complete`,
            jsonBody(`POST`, { provider: flow.provider, redirectUrl: redirectUrl.trim(), state: flow.state }),
        );
        await refreshTranslatorAccounts();
        // The row is the proof the account landed: an account read that didn't answer (refreshTranslatorAccounts
        // swallows its own failure) leaves the panel and its poll up rather than claiming a connection nothing shows.
        if (translatorAccounts.value[flow.provider].length === 0) {
            return false;
        }
        // Only if this is still the same attempt: a restarted sign-in owns the panel now.
        if (translatorConnectFlow.value === flow) {
            settleTranslator();
        }
        // Catalog is only discoverable with a credential, so load it now rather than at the next reselect.
        void loadProviderModels(flow.provider);
        return true;
    } catch (caught) {
        error.value = errorMessage(caught, `That sign-in link could not be completed: copy the whole URL and try again.`);
        return false;
    } finally {
        accountBusy.value = undefined;
    }
};

// Drops one of the provider's connected accounts, addressed by its translator auth-file name.
export const disconnectTranslator = async (target: KeyedProvider, name: string): Promise<void> => {
    accountBusy.value = translatorKey(target, name);
    try {
        await sandboxRequest(`/translator/${target}/disconnect`, jsonBody(`POST`, { provider: target, name }));
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
    // The grant came back and was accepted, but the credential behind it is still being minted: there is nothing
    // left to ask the user for, and nothing to show yet either.
    readonly redeemed: boolean;
}
export const nativeConnectFlow = ref<NativeConnectFlow | undefined>(undefined);
// Display label typed for the account being connected; blank lets the daemon derive one.
export const connectLabel = ref(``);

// Device-code sign-in expires after 15 minutes; stop polling past it.
const CODEX_POLL_DEADLINE_MS = 15 * 60 * 1000;
let nativePollTimer: ReturnType<typeof setTimeout> | undefined;

// Clears the poll timer and connect UI state only; for a sign-in that finished, there's nothing else to abandon.
const settleConnect = (): void => {
    if (nativePollTimer !== undefined) {
        clearTimeout(nativePollTimer);
        nativePollTimer = undefined;
    }
    nativeConnectFlow.value = undefined;
    connectLabel.value = ``;
    connectSent.value = false;
};

// Abandons an in-progress handshake, safe to call repeatedly. Also tells the daemon (fire-and-forget): for
// every shape but paste, the poll runs there, not in this tab.
export const cancelConnect = (): void => {
    const flow = nativeConnectFlow.value;
    if (flow !== undefined) {
        void sandboxRequest(`${providerBase(flow.provider)}/login/cancel`, jsonBody(`POST`, { handshake: flow.handshake })).catch(() => undefined);
    }
    settleConnect();
};

// One poll tick for sign-ins that finish out of band: checks whether an account appeared (paste finishes via
// completeConnect instead). Checked against the flow object it started for, so a restarted handshake retires old ticks.
const pollNativeOnce = async (target: AgentProvider, deadline: number): Promise<void> => {
    const flow = nativeConnectFlow.value;
    if (flow?.provider !== target) {
        return;
    }
    if (Date.now() > deadline) {
        error.value = `The ${providerLabel(target)} sign-in expired: start the connection again.`;
        cancelConnect();
        return;
    }
    try {
        const connectedAccounts = await refreshAccounts(target);
        // By handshake, not object identity: redeeming a grant re-stamps the same attempt, and a tick that read that
        // as a replacement would retire the very poll the credential has to land through.
        if (nativeConnectFlow.value?.handshake !== flow.handshake) {
            return;
        }
        if (connectedAccounts.length > 0) {
            settleConnect();
            error.value = null;
            // Load the catalog now so the picker is populated immediately, not after the next reselect.
            void loadProviderModels(target);
            return;
        }
    } catch {
        // Transient (sandbox blip); keep polling until the deadline.
    }
    if (nativeConnectFlow.value?.handshake !== flow.handshake) {
        return;
    }
    nativePollTimer = setTimeout(() => void pollNativeOnce(target, deadline), 3000);
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
    cancelConnect();
    error.value = null;
    connectSent.value = false;
    // Held busy for the whole start so the button doesn't flash back to "Connect" before the flow lands.
    accountBusy.value = target;
    try {
        const path = `${providerBase(target)}/login/start`;
        let response: Response;
        try {
            // Which estate to sign in to (Z.ai sells several); absent takes the provider's default.
            response = await sandboxRequest(path, jsonBody(`POST`, variant === undefined ? {} : { variant }));
        } catch (err) {
            error.value = errorMessage(err, `Could not start the ${providerLabel(target)} connection: is your sandbox online?`);
            return;
        }
        if (!response.ok) {
            error.value = (await sandboxError(response, { method: `POST`, path })).message;
            return;
        }
        const body = (await response.json()) as LoginStart;
        nativeConnectFlow.value = {
            provider: target,
            url: body.url,
            code: body.code,
            state: body.state,
            flow: body.flow,
            variant: body.variant,
            handshake: body.handshake,
            redeemed: false,
        };
        // Paste-back never polls; every other shape polls until the daemon's own `expiresAt`, not a local deadline,
        // since that's the attempt that actually expires.
        if (body.flow !== `paste`) {
            nativePollTimer = setTimeout(() => void pollNativeOnce(target, body.expiresAt), 3000);
        }
    } finally {
        accountBusy.value = undefined;
    }
};

// Points the account card at the active conversation's provider on open; skipped mid-handshake so switching
// rows can't hide a code being approved. Torn down only by cancelConnect, the deadline, or a fresh start.
export const showActiveProvider = (): void => {
    if (nativeConnectFlow.value !== undefined || translatorConnectFlow.value !== undefined) {
        return;
    }
    const target = active.value.provider.value;
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
        error.value = `Start the connection first.`;
        return false;
    }
    accountBusy.value = flow.provider;
    try {
        const path = `${providerBase(flow.provider)}/login/complete`;
        const body =
            flow.flow === `redirect`
                ? { handshake: flow.handshake, redirectUrl: pasted.trim() }
                : { handshake: flow.handshake, code: pasted.trim(), label: connectLabel.value.trim() || undefined };
        let response: Response;
        try {
            response = await sandboxRequest(path, jsonBody(`POST`, body));
        } catch (err) {
            error.value = errorMessage(err, `Could not finish the ${providerLabel(flow.provider)} sign-in: is your sandbox online?`);
            return false;
        }
        if (!response.ok) {
            // Daemon's own message tells apart an expired attempt, a refused code, a bad state, or address.
            error.value = (await sandboxError(response, { method: `POST`, path })).message;
            return false;
        }
        const { account } = (await response.json()) as { account?: OauthAccount };
        error.value = null;
        // Accepted, with the credential still to be minted (every native redirect: the account lands through the
        // poll, not this response). Marked on the attempt so the panel waits instead of asking for the address again.
        if (account === undefined) {
            nativeConnectFlow.value = { ...flow, redeemed: true };
            return true;
        }
        addAccount(flow.provider, account);
        settleConnect();
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
