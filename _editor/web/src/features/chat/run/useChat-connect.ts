import { errorMessage } from "@intentic/ui/async";
import { type AgentProvider, type KeyedProvider, type LoginFlow, type LoginStart, type OauthAccount, providerLabel, providerSpec } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { translatorAccounts } from "../accounts/providerAccounts";
import { hasSignIn } from "../session/access";
import { active } from "../tabs/useChat-tabs";
import { loadProviderModels } from "../models/useChat-catalog";
import { accountBusy, addAccount, error, managedProvider, providerBase, refreshAccounts, refreshTranslatorAccounts } from "../accounts/useChat-accounts";
import { sandboxError, sandboxJson, sandboxRequest } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";

// In-flight subscription login; `baseline` is the account count at start, connected means growing past it.
export const translatorConnectFlow = ref<
    { provider: KeyedProvider; url: string; code: string; state: string; flow: "device" | "redirect"; baseline: number } | undefined
>(undefined);

// Routed row key, namespaced away from the provider id: native and translator accounts of the same provider
// are separate connections. `name` picks one subscription; omitted, the provider's sign-in.
export const translatorKey = (target: AgentProvider, name?: string): string => `translator:${target}${name === undefined ? `` : `:${name}`}`;
let translatorPollTimer: ReturnType<typeof setTimeout> | undefined;

// Provider's own account label for the sign-in-expired sentence, not a hardcoded default.
const translatorProviderLabel = (target: KeyedProvider): string => providerSpec(target)?.accountLabel ?? target;

// Polls the connection state until the provider flips connected, since CLIProxyAPI finishes every routed
// login (device or redirect) in the background.
const pollTranslatorOnce = async (target: KeyedProvider, deadline: number): Promise<void> => {
    if (translatorConnectFlow.value?.provider !== target) {
        return;
    }
    if (Date.now() > deadline) {
        error.value = `The ${translatorProviderLabel(target)} sign-in expired: start the connection again.`;
        translatorConnectFlow.value = undefined;
        return;
    }
    await refreshTranslatorAccounts();
    const flow = translatorConnectFlow.value;
    if (flow?.provider !== target) {
        return;
    }
    if (translatorAccounts.value[target].length > flow.baseline) {
        translatorConnectFlow.value = undefined;
        error.value = null;
        return;
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
    clearTimeout(translatorPollTimer);
    try {
        translatorConnectFlow.value = {
            provider: target,
            baseline: translatorAccounts.value[target].length,
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
// reachable, so the user pastes it). Success only means keep polling; the row flips once the poll sees it.
export const completeTranslator = async (redirectUrl: string): Promise<void> => {
    const flow = translatorConnectFlow.value;
    if (flow === undefined || flow.flow !== `redirect`) {
        return;
    }
    accountBusy.value = translatorKey(flow.provider);
    error.value = null;
    try {
        await sandboxJson(
            `/translator/${flow.provider}/complete`,
            jsonBody(`POST`, { provider: flow.provider, redirectUrl: redirectUrl.trim(), state: flow.state }),
        );
        await refreshTranslatorAccounts();
    } catch (caught) {
        error.value = errorMessage(caught, `That sign-in link could not be completed: copy the whole URL and try again.`);
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
            clearTimeout(translatorPollTimer);
            translatorConnectFlow.value = undefined;
        }
        await refreshTranslatorAccounts();
    } finally {
        accountBusy.value = undefined;
    }
};

// Abandons an in-flight subscription login; clearing the flow alone would stop the poll, but the timer is
// also cleared so a superseded tick can't fire.
export const cancelTranslatorConnect = (): void => {
    clearTimeout(translatorPollTimer);
    translatorConnectFlow.value = undefined;
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
        const connectedAccounts = await refreshAccounts(target, false);
        if (nativeConnectFlow.value !== flow) {
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
    if (nativeConnectFlow.value !== flow) {
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
    /* AND ONLY ONTO A PROVIDER THE CARD MANAGES. The card is where a credential is added or dropped, and a
     * provider that has no sign-in (an endpoint, an ACP agent) has neither: it carries its own credential, has
     * no chip in the switcher and no label of its own there, so following a chat onto one leaves the card
     * showing rows for a provider it cannot connect, under a raw id, with no chip lit.
     *
     * Which is the state a fresh sandbox opened in: nothing connected parks the first chat on the free trial
     * (useChat-accounts' repoint pass), the card followed it, and the row it drew offered a sign-in that
     * answers 404. Staying put leaves the card on the last provider it was pointed at, which resetChat seeds
     * from the user's own remembered pick and is always one of the switcher's own. */
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
        if (account === undefined) {
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
