import { errorMessage } from "@intentic/ui/async";
import { type AgentProvider, type KeyedProvider, type LoginFlow, type LoginStart, type OauthAccount, providerLabel, providerSpec } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { translatorAccounts } from "../accounts/providerAccounts";
import { active } from "../tabs/useChat-tabs";
import { loadProviderModels } from "../models/useChat-catalog";
import { accountBusy, addAccount, error, managedProvider, providerBase, refreshAccounts, refreshTranslatorAccounts } from "../accounts/useChat-accounts";
import { sandboxError, sandboxJson, sandboxRequest } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";

// --- Routed-provider subscriptions --------------------------------------------------------------
// The sandbox's translator (CLIProxyAPI) serves Codex/Grok/Kimi/Google models to the Claude Code harness on the
// user's subscription OAuth, a credential of its own, separate from a provider's native-harness
// account (each program owns and refreshes its own grant; a shared refresh token would rotate out from under
// one of them). The connection state itself lives in conversation.ts beside providerAccounts (so access.ts can
// derive from both without a cycle); what stays here is the login flow it is driven by, held outside
// SandboxAgent so a device-login poll survives that tab unmounting.
// The in-flight subscription login the Agent tab's routed row shows. Device flows may carry a one-time `code`;
// redirect flows ask the user to paste the URL they landed on and `completeTranslator` finishes it against
// `state`. `baseline` is how many accounts
// the provider held when the login started, a provider can hold several, so "connected" is the count GROWING
// past it, not the provider being truthy (which an "add another account" login already is from the start).
export const translatorConnectFlow = ref<
    { provider: KeyedProvider; url: string; code: string; state: string; flow: "device" | "redirect"; baseline: number } | undefined
>(undefined);

/* A routed row's key. Namespaced away from the provider id on purpose: under Grok the native xAI account and
 * the translator subscription are two connections of the SAME provider, sitting one above the other, and keying
 * both as `grok` made a click on either spin both their buttons. With `name`, one specific subscription (auth
 * file names are unique per provider, not across them); without it, that provider's sign-in. */
export const translatorKey = (target: AgentProvider, name?: string): string => `translator:${target}${name === undefined ? `` : `:${name}`}`;
let translatorPollTimer: ReturnType<typeof setTimeout> | undefined;

// What an expired sign-in names itself in the sentence that reports it. The provider's own account label, not a
// fourth chain of ternaries: the one this replaced fell through to "Google" for anything it did not name, so a
// routed provider added tomorrow would have reported its own timeout as Google's.
const translatorProviderLabel = (target: KeyedProvider): string => providerSpec(target)?.accountLabel ?? target;

// CLIProxyAPI finishes every routed login in the background, the device flows poll upstream on their own, and
// a redirect flow resumes the moment `completeTranslator` hands it the pasted URL, so in both cases the UI just
// polls the connection state until the provider flips connected, bounded by the device flows' deadline.
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

// Start a subscription login for a routed provider: the daemon returns the sign-in URL and, for the providers
// that mint one, a one-time code. The user approves upstream and the poll flips the row to connected. One flow
// at a time, a new connect supersedes a prior one (mirroring the daemon, which kills a superseded subprocess).
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

// Finish a redirect login by handing the daemon the URL the provider sent the browser to. Google's sign-in ends
// on a loopback address only the sandbox container binds, so the page never loads for the user, but the address
// bar still carries the grant, which is what they paste here. The translator then resumes the exchange on its
// own, so success just means "keep polling"; the row flips connected on the next poll.
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

// Drop ONE of the provider's connected accounts, addressed by its translator auth-file name.
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

// Abandon an in-flight subscription login. Dropping the flow is enough to stop its poll (every tick returns
// early once the flow it was started for is gone), but the pending timer is cleared too so a superseded tick
// can't fire against a row the user has moved on from.
export const cancelTranslatorConnect = (): void => {
    clearTimeout(translatorPollTimer);
    translatorConnectFlow.value = undefined;
};

/* The in-flight NATIVE sign-in, held between start and completion: the wire's LoginStart minus its deadline
 * (which arms the poll instead), plus the PROVIDER it belongs to, which is what lets a handshake outlive a look
 * at another tab: the flow unfolds under the row that started it and nowhere else, so browsing the switcher can
 * neither smear a Grok device code onto Claude's row nor force us to kill a sign-in the user is still
 * completing at x.ai.
 *
 * `flow` says how it ENDS, the one thing a card cannot infer from the other fields: a device sign-in finishes
 * upstream and the account appears on its own; a redirect dead-ends on a loopback address the user brings back;
 * a paste needs the code the page showed. `handshake` is the attempt's id, for finishing or abandoning it: not
 * a credential and not redeemable, the proof that finishes the sign-in never leaves the sandbox. */
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
// The display label the user typed for the account being connected (blank ⇒ the daemon derives one from the
// sign-in identity or a provider default). Bound by the account panel; read when a connect completes.
export const connectLabel = ref(``);

// Device-code sign-in expires after 15 minutes; stop polling past it.
const CODEX_POLL_DEADLINE_MS = 15 * 60 * 1000;
let nativePollTimer: ReturnType<typeof setTimeout> | undefined;

// Drop the poll timer and the connect UI state, and nothing else: what a sign-in that FINISHED does, since
// the attempt behind it is spent and there is nothing left to abandon.
const settleConnect = (): void => {
    if (nativePollTimer !== undefined) {
        clearTimeout(nativePollTimer);
        nativePollTimer = undefined;
    }
    nativeConnectFlow.value = undefined;
    connectLabel.value = ``;
};

/* Abandon an in-progress handshake. Safe to call repeatedly. The extra step over settling is the daemon: for
 * every shape but the paste, the handshake is a POLL RUNNING THERE, not in this tab, so closing the card
 * without saying so would leave the sandbox asking upstream about a sign-in nobody is completing for the next
 * fifteen minutes. Fire-and-forget: the attempt expires on its own anyway, so a failed cancel costs nothing
 * worth reporting. */
export const cancelConnect = (): void => {
    const flow = nativeConnectFlow.value;
    if (flow !== undefined) {
        void sandboxRequest(`${providerBase(flow.provider)}/login/cancel`, jsonBody(`POST`, { handshake: flow.handshake })).catch(() => undefined);
    }
    settleConnect();
};

/* One tick of a sign-in's poll, for every shape that finishes out of band: the daemon (or OpenCode, for xAI)
 * completes the exchange itself, so the question this asks is the only one this tab can — has an account
 * appeared yet. A paste-back finishes via completeConnect instead and never polls.
 *
 * Supersession is checked against the flow OBJECT the tick was started for, so a restarted or cancelled
 * handshake retires the ticks of the old one rather than racing them. */
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
            // The account just connected, load its model catalog now so the picker is populated immediately,
            // not only after the next reselect or reload.
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

// Step 1 of a NATIVE connect. Claude mints an authorize URL + PKCE challenge; Grok mints a one-time device code
// and starts its poll loop. Routed subscription connects, including Kimi Code, use connectTranslator above.

// Started by the row's own Connect button (never by a provider switch, see setManagedProvider), so the whole
// handshake is a thing the user asked for. `accountBusy` holds the provider for the length of the round-trip:
// that is the click's acknowledgement, and it is why the sign-in can only ever REPLACE the button that started
// it rather than appear next to a button still inviting the same click.
export const startConnect = async (variant?: string): Promise<void> => {
    const target = managedProvider.value;
    if (accountBusy.value !== undefined) {
        return;
    }
    cancelConnect();
    error.value = null;
    // Busy for the WHOLE start, not just the fetch: clearing it a parse earlier would drop the button back to
    // "Connect" for a tick before the flow lands under it, the very blink this is here to remove.
    accountBusy.value = target;
    try {
        const path = `${providerBase(target)}/login/start`;
        let response: Response;
        try {
            // The estate to sign in to, for a provider that sells through more than one (Z.ai). Absent takes the
            // provider's default, which is what every single-estate row sends.
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
        /* A paste-back ends in completeConnect and never polls. Every other shape finishes out of band and the
         * poll is how this tab learns it worked, bounded by the daemon's own deadline rather than a constant of
         * this tab's: the daemon's attempt is the one that actually expires, and a card that gave up first would
         * report an abandoned sign-in that was still live. */
        if (body.flow !== `paste`) {
            nativePollTimer = setTimeout(() => void pollNativeOnce(target, body.expiresAt), 3000);
        }
    } finally {
        accountBusy.value = undefined;
    }
};

/* Point the account card at the provider the active conversation would send to, what it shows when it opens.
 * Skipped while a sign-in is in flight: that handshake (a device poll can outlive the card being closed and the
 * reachable-flash remounting it) owns what the card is looking at, and moving to another provider's rows would
 * hide the code the user is in the middle of approving.
 *
 * Nothing here tears a handshake down, and nothing does on the way out either, there is no "close" hook at all.
 * The Grok device flow completes out-of-band (the user approves at x.ai and the daemon exchanges tokens
 * server-side later), so cancelConnect stays the sole teardown, driven only by genuine invalidation:
 * completion (pollGrokOnce), the 15-minute deadline, a fresh startConnect, the user's own Cancel, or resetChat. */
export const showActiveProvider = (): void => {
    if (nativeConnectFlow.value === undefined && translatorConnectFlow.value === undefined) {
        managedProvider.value = active.value.provider.value;
    }
};

/* Step 2 of a sign-in that needs something brought back: the code the page showed (a paste), or the address a
 * redirect dead-ended on. Device flows complete via the poll and have nothing to hand back.
 *
 * THE TWO ENDINGS DIFFER, which is why the answer's shape decides rather than the provider. Anthropic's
 * exchange ANSWERS with the account, so this lands it and settles. A minted provider's redirect only DELIVERS
 * THE GRANT: the daemon still has an exchange and a mint to do behind the answer, so all this can report is
 * that the address was accepted, and the poll already running from `startConnect` is what turns it into a row.
 * Treating the second like the first would clear the card while the sign-in was still working, and a failure
 * minutes later would have nowhere to land. */
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
            // The daemon's own words: an expired attempt, a code the vendor refused, a state that belongs to
            // another attempt and an address with no grant in it send the user somewhere different, and only it
            // knows which happened.
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
        // The account just connected, so its catalog may only now be discoverable (Claude's supportedModels
        // needs a credential).
        void loadProviderModels(flow.provider);
        return true;
    } finally {
        accountBusy.value = undefined;
    }
};

// A singleton per window (hotReload.ts): a hot update that re-ran this module would mint a second sign-in flow
// beside the one the rest of the app still reads.
reloadOnHotUpdate(import.meta);
