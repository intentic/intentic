import { WEBEXT_PAIR_MESSAGE, WEBEXT_PAIRED_MESSAGE, type WebExtSummary, webextPairingCode } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { onRuntimeChanged } from "./runtimeEvents";
import { sandboxRequest } from "./sandboxClient";
import { useSandbox } from "./useSandbox";

/* Drives "Connect this browser" on a webext capability's card — the host-connect flow with the one-liner
 * replaced by a code, because the far end is not a terminal.
 *
 * Connect mints a single-use pairing BOUND TO THIS CAPABILITY, so the code it produces can only ever connect
 * the browser the user is looking at. The extension coming online is what the user is standing there waiting
 * for and it happens out-of-band, so the daemon pushes it (`webext`) rather than this card asking on a clock.
 *
 * THE HANDOFF IS THE INTERESTING PART. The code is also posted on this window, where the extension's own
 * content script picks it up (it is loaded on this origin and no other), so a person with the extension already
 * installed never copies anything: their popup lights up with "a sandbox wants to connect". The page learns the
 * extension is there from the answer, and says so. Everything still needs their click in the popup — a page
 * must not be able to connect somebody's browser to a sandbox on its own, and Chrome would refuse anyway, since
 * redeeming needs a permission only a user gesture can grant.
 *
 * The token is shown once and never stored: a re-click mints a fresh one, which is cheaper than keeping a live
 * credential in a browser tab for ten minutes. */
export function useWebExtConnect() {
    const { daemonUrl } = useSandbox();

    const browsers = ref<readonly WebExtSummary[]>([]);
    const pairId = ref<string | undefined>(undefined);
    const pairToken = ref<string | undefined>(undefined);
    const minting = ref(false);
    const error = ref<string | undefined>(undefined);
    // Whether an installed extension answered the handoff. Undefined until we have offered one: "we do not know
    // yet" and "nothing answered" are different things to say to somebody who is waiting.
    const extensionHere = ref<boolean | undefined>(undefined);

    const url = computed(() => daemonUrl.value ?? ``);
    const code = computed(() =>
        url.value === `` || pairToken.value === undefined ? `` : webextPairingCode({ url: url.value, token: pairToken.value }),
    );

    const refresh = async (): Promise<void> => {
        try {
            const response = await sandboxRequest(`/system/webext`);
            if (!response.ok) {
                return;
            }
            browsers.value = ((await response.json()) as { browsers?: WebExtSummary[] }).browsers ?? [];
        } catch {
            // Sandbox not reachable: leave the last known state rather than blanking the card.
        }
    };

    // The extension answers on this same window when it has the code. One listener per offer, removed when the
    // dialog closes, so a stale one cannot mark a later attempt as answered.
    let listener: ((event: MessageEvent) => void) | undefined;
    const offer = (): void => {
        if (code.value === ``) {
            return;
        }
        extensionHere.value = undefined;
        listener = (event: MessageEvent) => {
            if (event.source === window && (event.data as { type?: unknown } | undefined)?.type === WEBEXT_PAIRED_MESSAGE) {
                extensionHere.value = true;
            }
        };
        window.addEventListener(`message`, listener);
        window.postMessage({ type: WEBEXT_PAIR_MESSAGE, code: code.value }, window.location.origin);
        // Nothing answering within a moment means no extension on this browser — which is the ordinary case
        // when the browser being connected is a different one from the one this page is open in.
        setTimeout(() => {
            extensionHere.value ??= false;
        }, 1200);
    };

    // Owner-only server-side; a member's click comes back 403 and says so rather than silently doing nothing.
    const connect = async (id: string): Promise<void> => {
        minting.value = true;
        error.value = undefined;
        try {
            const response = await sandboxRequest(`/system/webext/pair?id=${encodeURIComponent(id)}`, { method: `POST` });
            if (!response.ok) {
                error.value =
                    response.status === 403
                        ? `Only the sandbox's owner can connect a browser.`
                        : `Couldn't start the connection (${response.status}).`;
                return;
            }
            pairToken.value = ((await response.json()) as { token: string }).token;
            pairId.value = id;
            offer();
        } finally {
            minting.value = false;
        }
    };

    let unsubscribe: (() => void) | undefined;
    // Pushed rather than polled, the host card's story exactly (useHostConnect): a browser is online iff its
    // socket is held in webext-hub.ts, so the daemon announces the redemption on the `webext` domain the moment
    // the person clicks Connect in their popup. One read on open, then silence until that lands.
    const start = (): void => {
        void refresh();
        unsubscribe ??= onRuntimeChanged([`webext`], () => void refresh());
    };
    const stop = (): void => {
        unsubscribe?.();
        unsubscribe = undefined;
    };

    const close = (): void => {
        pairToken.value = undefined;
        pairId.value = undefined;
        error.value = undefined;
        extensionHere.value = undefined;
        if (listener !== undefined) {
            window.removeEventListener(`message`, listener);
            listener = undefined;
        }
    };

    // Revoke: the extension's key is dropped and its socket cut. The capability stays, so the card can offer
    // Connect again — reconnecting is a fresh pairing, not a recovered one.
    const revoke = async (id: string): Promise<void> => {
        await sandboxRequest(`/system/webext/${encodeURIComponent(id)}`, { method: `DELETE` });
        await refresh();
    };

    const browserFor = (id: string): WebExtSummary | undefined => browsers.value.find((browser) => browser.id === id);

    return { browsers, browserFor, pairId, pairToken, code, minting, error, extensionHere, connect, revoke, refresh, start, stop, close };
}
