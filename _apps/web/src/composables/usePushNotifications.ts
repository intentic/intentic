import type { PushConfig } from "@intentic-app/api-contract";
import type { PushTest } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { sandboxJson } from "./sandbox/sandboxClient";
import { jsonBody } from "./sandbox/jsonBody";
import { useSandbox } from "./sandbox/useSandbox";

/* Web push, from the browser's side. Enabling it is a four-link chain and every link can fail independently:
 *
 *   service worker registered → Notification permission granted → PushManager subscription minted →
 *   that subscription stored on the daemon
 *
 * The state below reports which link the user is actually on, because "notifications are off" is useless
 * advice when the cause is a permission the browser will never re-prompt for. In particular `denied` is
 * terminal — the page cannot ask again, only the user can undo it in site settings — so it gets its own state
 * rather than being folded into "off".
 *
 * The subscription is per-BROWSER and per-sandbox: the endpoint belongs to this browser, and it is stored on
 * the daemon this browser is driving. Enabling on a laptop therefore says nothing about a phone, which is the
 * behaviour people expect from notifications. */

export type PushState =
    // This browser has no Push API / no service-worker support (or the page is not on a secure origin).
    | "unsupported"
    // The user blocked notifications for this origin; nothing here can recover it.
    | "denied"
    // Supported and not blocked, but this browser is not registered with the daemon.
    | "off"
    | "on";

const SW_URL = `/sw.js`;

// Push wants the VAPID key as raw bytes; the daemon serves it base64url (the form web-push generates).
// Typed as Uint8Array<ArrayBuffer> because applicationServerKey requires a non-shared buffer — the default
// Uint8Array's ArrayBufferLike admits SharedArrayBuffer, which the DOM type rejects.
const decodeKey = (base64Url: string): Uint8Array<ArrayBuffer> => {
    const padded = base64Url.padEnd(base64Url.length + ((4 - (base64Url.length % 4)) % 4), `=`);
    const binary = atob(padded.replace(/-/g, `+`).replace(/_/g, `/`));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
};

const supported = (): boolean => `serviceWorker` in navigator && `PushManager` in window && `Notification` in window;

// `options.applicationServerKey` is the raw key the subscription was minted with, so comparing it against the
// daemon's current one answers exactly the question that matters: can the daemon still send to this endpoint?
const boundTo = (subscription: PushSubscription, publicKey: string): boolean => {
    const bound = subscription.options.applicationServerKey;
    if (bound === null) {
        return false;
    }
    const current = decodeKey(publicKey);
    const bytes = new Uint8Array(bound);
    return bytes.length === current.length && bytes.every((byte, index) => byte === current[index]);
};

// Brave exposes this and nothing else does. It ships with Google's push service disabled, and since web push
// has no other transport, subscribing cannot succeed until that setting is on — worth detecting, because the
// fix is a specific toggle we can name instead of a shrug.
const isBrave = async (): Promise<boolean> => {
    const { brave } = navigator as Navigator & { brave?: { isBrave: () => Promise<boolean> } };
    return brave !== undefined && (await brave.isBrave());
};

/* Why subscribe() gets its own diagnosis: it fails independently of the permission the user just granted, and
 * the browser's own message for it ("Registration failed - push service error") names nothing anyone can act
 * on. Worse, it surfaces on a page about this sandbox, so it reads as "the sandbox broke" when the daemon was
 * never involved — the browser could not register with its push service at all. */
const pushServiceAdvice = async (): Promise<string> =>
    (await isBrave())
        ? `Brave ships with push messaging turned off. Enable "Use Google services for push messaging" in brave://settings/privacy, restart Brave, then try again.`
        : `Your browser's push service refused to register this browser — nothing on the sandbox side can fix it. A VPN or firewall blocking the browser's push connection is the usual cause.`;

// The browser's half of turning it on. Reuse an existing subscription where possible — re-subscribing mints a
// new endpoint and orphans the old row — but ONLY when it is still bound to the daemon's key. A recreated
// sandbox generates a fresh VAPID pair, and an endpoint bound to the old one is refused on every send while
// the toggle happily reports "on"; dropping it and minting a new one is the only repair.
const mint = async (manager: PushManager, publicKey: string): Promise<PushSubscription> => {
    const existing = await manager.getSubscription();
    if (existing !== null) {
        if (boundTo(existing, publicKey)) {
            return existing;
        }
        await existing.unsubscribe();
    }
    try {
        // `userVisibleOnly` is mandatory in Chrome — silent push is not permitted.
        return await manager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(publicKey) });
    } catch (cause) {
        throw new Error(await pushServiceAdvice(), { cause });
    }
};

export function usePushNotifications() {
    const { reachable } = useSandbox();
    const state = ref<PushState>(supported() ? `off` : `unsupported`);
    const busy = ref(false);
    const error = ref<string | undefined>(undefined);
    // How many browsers the last test send actually reached. Undefined until one is sent — the count is the
    // only part of the chain the page can observe, and it is what separates "your OS swallowed it" from "the
    // daemon sent nothing", which look identical from a button that just goes quiet.
    const delivered = ref<number | undefined>(undefined);
    const canToggle = computed(() => state.value !== `unsupported` && state.value !== `denied` && !busy.value && reachable.value);

    const registration = async (): Promise<ServiceWorkerRegistration> => navigator.serviceWorker.register(SW_URL);

    // What the browser currently holds, if anything. Distinct from what the DAEMON holds — the two can
    // disagree (a sandbox reset drops the server row while the browser subscription lives on), and `refresh`
    // below is what reconciles them.
    const localSubscription = async (): Promise<PushSubscription | null> => (await registration()).pushManager.getSubscription();

    // Bumped by every user action. `refresh` is a slow read — a service-worker lookup plus a daemon round-trip —
    // and it now runs the moment the daemon comes online, which is exactly when someone is likely to be
    // reaching for the toggle. A read that lands after a write and reports the world as it was before it is
    // the same "it forgot my setting" the page is being fixed for, so each refresh notes the revision it began
    // under and declines to write if anything happened since.
    let revision = 0;

    // Establish what is actually true, from all three sources at once: the permission the browser granted, the
    // subscription it is holding, and whether the daemon has a row for that subscription.
    const refresh = async (): Promise<void> => {
        if (!supported()) {
            state.value = `unsupported`;
            return;
        }
        if (Notification.permission === `denied`) {
            state.value = `denied`;
            return;
        }
        if (!reachable.value) {
            return;
        }
        const started = revision;
        try {
            const existing = await localSubscription();
            const query = existing === null ? `` : `?endpoint=${encodeURIComponent(existing.endpoint)}`;
            const config = await sandboxJson<PushConfig>(`/push/config${query}`);
            if (revision !== started) {
                return;
            }
            // All three have to line up before this reads "on". A subscription the daemon has since forgotten
            // delivers nothing, and one bound to a retired key is rejected at every send. Either would let the
            // page advertise a working notification chain that is quietly dead — the exact lie to avoid here.
            state.value = existing !== null && config.subscribed && boundTo(existing, config.publicKey) ? `on` : `off`;
        } catch {
            // A daemon that can't be read tells us nothing about the subscription — leave the last known
            // state rather than flipping the toggle under the user on a transient blip.
        }
    };

    const enable = async (): Promise<void> => {
        error.value = undefined;
        // A count from the previous registration says nothing about this one.
        delivered.value = undefined;
        revision += 1;
        busy.value = true;
        try {
            const permission = await Notification.requestPermission();
            if (permission !== `granted`) {
                state.value = permission === `denied` ? `denied` : `off`;
                return;
            }
            const config = await sandboxJson<PushConfig>(`/push/config`);
            const manager = (await registration()).pushManager;
            const subscription = await mint(manager, config.publicKey);
            await sandboxJson(`/push/subscribe`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                // toJSON() produces exactly the {endpoint, keys:{p256dh, auth}} shape the daemon stores.
                body: JSON.stringify(subscription.toJSON()),
            });
            state.value = `on`;
        } catch (cause) {
            error.value = cause instanceof Error ? cause.message : `Could not enable notifications.`;
            await refresh();
        } finally {
            busy.value = false;
        }
    };

    const disable = async (): Promise<void> => {
        error.value = undefined;
        delivered.value = undefined;
        revision += 1;
        busy.value = true;
        try {
            const subscription = await localSubscription();
            if (subscription !== null) {
                // Tell the daemon FIRST: if the browser-side unsubscribe succeeds and the daemon call then
                // fails, the daemon is left pushing at a dead endpoint (harmless — it prunes on 410 — but it
                // would keep reporting "on"). This order fails in the recoverable direction instead.
                await sandboxJson(`/push/unsubscribe`, jsonBody(`POST`, { endpoint: subscription.endpoint }));
                await subscription.unsubscribe();
            }
            state.value = `off`;
        } catch (cause) {
            error.value = cause instanceof Error ? cause.message : `Could not turn notifications off.`;
            await refresh();
        } finally {
            busy.value = false;
        }
    };

    // An end-to-end proof of the chain: daemon key -> push service -> service worker -> OS. Not one of those
    // four hops is visible from the settings page, and no status text can stand in for the thing itself, so
    // the button's whole value is that a notification either shows up on the machine or it doesn't —
    // provided it also reports the half the user CAN'T see. The daemon answers with how many browsers it
    // reached and errors on a zero, so "nothing appeared" now splits into "the daemon sent to nobody"
    // (actionable, and it says how) and "it sent to you and your OS didn't show it".
    const sendTest = async (): Promise<void> => {
        error.value = undefined;
        delivered.value = undefined;
        busy.value = true;
        try {
            delivered.value = (await sandboxJson<PushTest>(`/push/test`, { method: `POST` })).delivered;
        } catch (cause) {
            error.value = cause instanceof Error ? cause.message : `Could not send a test notification.`;
            // A push service that refuses a send makes the daemon drop that registration, so a failed test can
            // mean this browser is no longer subscribed. Re-read instead of leaving a toggle reading "on" for a
            // device the daemon just forgot — the error says to toggle it again, which needs a visible toggle.
            await refresh();
        } finally {
            busy.value = false;
        }
    };

    /* Reconcile on mount AND every time the daemon comes online — not on mount alone. The settings page can
     * mount while the connection is still being established (the shell paints a hydrated workspace rather than
     * the connecting gate for a sandbox that is merely slow), and a `refresh` that lands in that window has
     * nobody to ask: it returns leaving `state` at its initial `off`, and nothing ever asks again. The result
     * read as the setting not being persisted — every reload showed the toggle off for a browser that was in
     * fact subscribed, and turning it "on" again was really just the first read that ever succeeded. */
    watch(reachable, () => void refresh(), { immediate: true });

    return { state, busy, error, delivered, canToggle, enable, disable, sendTest, refresh };
}
