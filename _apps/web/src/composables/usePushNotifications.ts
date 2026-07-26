import type { PushConfig } from "@intentic-app/api-contract";
import { computed, onMounted, ref } from "vue";
import { sandboxJson } from "./sandbox/sandboxClient";
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

export function usePushNotifications() {
    const { reachable } = useSandbox();
    const state = ref<PushState>(supported() ? `off` : `unsupported`);
    const busy = ref(false);
    const error = ref<string | undefined>(undefined);
    const canToggle = computed(() => state.value !== `unsupported` && state.value !== `denied` && !busy.value && reachable.value);

    const registration = async (): Promise<ServiceWorkerRegistration> => navigator.serviceWorker.register(SW_URL);

    // What the browser currently holds, if anything. Distinct from what the DAEMON holds — the two can
    // disagree (a sandbox reset drops the server row while the browser subscription lives on), and `refresh`
    // below is what reconciles them.
    const localSubscription = async (): Promise<PushSubscription | null> => (await registration()).pushManager.getSubscription();

    // Read the true state: the browser's permission, its subscription, and whether the daemon knows about it.
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
        try {
            const existing = await localSubscription();
            const query = existing === null ? `` : `?endpoint=${encodeURIComponent(existing.endpoint)}`;
            const config = await sandboxJson<PushConfig>(`/push/config${query}`);
            // "On" requires BOTH halves. A browser subscription the daemon has forgotten would notify
            // nothing, and reporting that as on is exactly the silent failure this feature can't afford.
            state.value = existing !== null && config.subscribed ? `on` : `off`;
        } catch {
            // A daemon that can't be read tells us nothing about the subscription — leave the last known
            // state rather than flipping the toggle under the user on a transient blip.
        }
    };

    const enable = async (): Promise<void> => {
        error.value = undefined;
        busy.value = true;
        try {
            const permission = await Notification.requestPermission();
            if (permission !== `granted`) {
                state.value = permission === `denied` ? `denied` : `off`;
                return;
            }
            const config = await sandboxJson<PushConfig>(`/push/config`);
            const manager = (await registration()).pushManager;
            // Reuse an existing subscription when there is one: re-subscribing mints a new endpoint and
            // orphans the old row. `userVisibleOnly` is mandatory in Chrome — silent push is not permitted.
            const subscription =
                (await manager.getSubscription()) ??
                (await manager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(config.publicKey) }));
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
        busy.value = true;
        try {
            const subscription = await localSubscription();
            if (subscription !== null) {
                // Tell the daemon FIRST: if the browser-side unsubscribe succeeds and the daemon call then
                // fails, the daemon is left pushing at a dead endpoint (harmless — it prunes on 410 — but it
                // would keep reporting "on"). This order fails in the recoverable direction instead.
                await sandboxJson(`/push/unsubscribe`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    body: JSON.stringify({ endpoint: subscription.endpoint }),
                });
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

    // Proves the whole chain end-to-end — daemon key, push service, service worker, OS. Four failure points
    // the user cannot inspect, so a button that either produces a notification or doesn't is worth more than
    // any amount of status text.
    const sendTest = async (): Promise<void> => {
        error.value = undefined;
        busy.value = true;
        try {
            await sandboxJson(`/push/test`, { method: `POST` });
        } catch (cause) {
            error.value = cause instanceof Error ? cause.message : `Could not send a test notification.`;
        } finally {
            busy.value = false;
        }
    };

    onMounted(() => void refresh());

    return { state, busy, error, canToggle, enable, disable, sendTest, refresh };
}
