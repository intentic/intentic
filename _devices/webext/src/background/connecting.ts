import { parseWebextPairingCode } from "@intentic/sandbox-contract/webext";
import { CHOICE_HOLD_MS, type PairedSandbox, type SandboxKey, sandboxKey, store } from "./store.js";
import { openPanel, refreshBadge } from "./tools/access.js";

// How a Connect press in the popup becomes a paired sandbox even though Chrome closes the popup the moment its own
// permission dialog takes focus (crbug.com/40721470). Until 2026-11-05 the popup asked Chrome for the sandbox's origin
// and only then told the worker to redeem the code: the person allowed the site, the popup was already gone, nothing
// was redeemed, and they had to open the popup and do it all again, this time with Chrome already holding the site.
// Now the popup hands the pairing over first (`arm`) and the grant arriving finishes it (`granted`, from
// `chrome.permissions.onAdded`), the way a site's read/act pick is filed (site-grants.ts). When Chrome holds the origin
// already no dialog comes and no grant is added, and the popup, still open, finishes it itself (`finish`).

export interface Connected {
    readonly ok: boolean;
    readonly message: string;
}

// One at a time: the grant and the popup can both reach for the same pairing, and its code redeems only once.
let queue: Promise<unknown> = Promise.resolve();
const serial = async <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next;
    return await next;
};

const originOf = (url: string): string => `${new URL(url).origin}/*`;

export const connecting = (pairWith: (pairing: PairedSandbox) => Promise<Connected>) => {
    // Redeems the pairing armed for `key`, once: whichever arrives first, Chrome's grant or the popup that outlived
    // the request, does it, and the other answers from what that left.
    const finish = async (key: SandboxKey, now = Date.now()): Promise<Connected> =>
        await serial(async () => {
            const armed = await store.armed();
            if (armed !== undefined && sandboxKey(armed.url) === key && now - armed.at < CHOICE_HOLD_MS) {
                await store.setArmed(undefined);
                const { at: _at, ...pairing } = armed;
                const result = await pairWith(pairing);
                await store.setConnectFailed(result.ok ? undefined : { url: key, error: result.message });
                return result;
            }
            const failed = await store.connectFailed();
            if (failed?.url === key) {
                return { ok: false, message: failed.error };
            }
            return (await store.sandbox(key)) === undefined
                ? { ok: false, message: `That request is gone. Click Connect again in your sandbox.` }
                : { ok: true, message: `Connected.` };
        });

    return {
        // The person pressed Connect on a pasted code, or on the pairing a sandbox's page parked (no code): held until
        // Chrome says yes to its origin. Called before the popup's request, which must come before any await there.
        arm: async (code: string | undefined, now = Date.now()): Promise<Connected> =>
            await serial(async () => {
                const pairing = code === undefined ? await store.inbox() : parseWebextPairingCode(code);
                if (pairing === undefined) {
                    return { ok: false, message: `That request is gone. Click Connect again in your sandbox.` };
                }
                await store.setArmed({ ...pairing, at: now });
                await store.setConnectFailed(undefined);
                return { ok: true, message: `Waiting for the browser.` };
            }),
        finish,
        // Chrome added sites. One that is the armed sandbox's own origin finishes its pairing here, with the popup
        // most likely closed: a failure is kept on that sandbox's offer, which the popup is opened on, so it is said
        // where the person can press Connect again rather than lost with the popup.
        granted: async (origins: readonly string[], now = Date.now()): Promise<void> => {
            const armed = await store.armed();
            if (armed === undefined || !origins.includes(originOf(armed.url))) {
                return;
            }
            const result = await finish(sandboxKey(armed.url), now);
            if (!result.ok) {
                const { at: _at, ...pairing } = armed;
                await store.setInbox(pairing);
                await refreshBadge();
                await openPanel(true);
            }
        },
    };
};
