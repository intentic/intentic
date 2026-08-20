import type { PushConfig } from "@intentic-app/api-contract";
import type { PushTest } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { nativePushDriver } from "../push/nativePush";
import { webPushDriver } from "../push/webPush";
import { inNativeShell } from "../shell/capacitor";
import { jsonBody } from "./sandbox/jsonBody";
import { sandboxJson } from "./sandbox/sandboxClient";
import { useSandbox } from "./sandbox/useSandbox";

/* Push, from the device's side. HOW this device receives a notification is the driver's business (webPush.ts
 * for browsers — including the Android TWA — and nativePush.ts for the iOS shell, picked once below); this
 * composable owns the flow, which is the same everywhere: enabling is a chain and every link can fail
 * independently:
 *
 *   transport available → permission granted → registration minted → that channel stored on the daemon
 *
 * The state below reports which link the user is actually on, because "notifications are off" is useless
 * advice when the cause is a permission the platform will never re-prompt for. In particular `denied` is
 * terminal — the page cannot ask again, only the user can undo it in settings — so it gets its own state
 * rather than being folded into "off".
 *
 * The registration is per-DEVICE and per-sandbox: the channel belongs to this device, and it is stored on
 * the daemon this device is driving. Enabling on a laptop therefore says nothing about a phone, which is the
 * behaviour people expect from notifications. */

export type PushState =
    // No push transport here (no Push API / no secure origin in a browser; a shell build without the plugin).
    | "unsupported"
    // The user blocked notifications for this app; nothing here can recover it.
    | "denied"
    // Supported and not blocked, but this device is not registered with the daemon.
    | "off"
    | "on";

// The one driver decision, made once at module load: the environment cannot change under a running page.
const driver = inNativeShell() ? nativePushDriver : webPushDriver;

export function usePushNotifications() {
    const { reachable } = useSandbox();
    const state = ref<PushState>(driver.supported() ? `off` : `unsupported`);
    const busy = ref(false);
    const error = ref<string | undefined>(undefined);
    // How many devices the last test send actually reached. Undefined until one is sent — the count is the
    // only part of the chain the page can observe, and it is what separates "your OS swallowed it" from "the
    // daemon sent nothing", which look identical from a button that just goes quiet.
    const delivered = ref<number | undefined>(undefined);
    const canToggle = computed(() => state.value !== `unsupported` && state.value !== `denied` && !busy.value && reachable.value);

    // Bumped by every user action. `refresh` is a slow read — a driver lookup plus a daemon round-trip — and
    // it runs the moment the daemon comes online, which is exactly when someone is likely to be reaching for
    // the toggle. A read that lands after a write and reports the world as it was before it is the same "it
    // forgot my setting" the page is being fixed for, so each refresh notes the revision it began under and
    // declines to write if anything happened since.
    let revision = 0;

    // Establish what is actually true, from all three sources at once: the permission granted here, the
    // registration this device is holding, and whether the daemon has a row for it.
    const refresh = async (): Promise<void> => {
        if (!driver.supported()) {
            state.value = `unsupported`;
            return;
        }
        if (await driver.denied()) {
            state.value = `denied`;
            return;
        }
        if (!reachable.value) {
            return;
        }
        const started = revision;
        try {
            const id = await driver.localId();
            const query = id === null ? `` : `?id=${encodeURIComponent(id)}`;
            const config = await sandboxJson<PushConfig>(`/push/config${query}`);
            if (revision !== started) {
                return;
            }
            // All three have to line up before this reads "on". A registration the daemon has since forgotten
            // delivers nothing, and one bound to a retired key is rejected at every send. Either would let the
            // page advertise a working notification chain that is quietly dead — the exact lie to avoid here.
            state.value = id !== null && config.subscribed && (await driver.bound(config.publicKey)) ? `on` : `off`;
        } catch {
            // A daemon that can't be read tells us nothing about the registration — leave the last known
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
            const minted = await driver.mint(async () => (await sandboxJson<PushConfig>(`/push/config`)).publicKey);
            if (minted.outcome !== `granted`) {
                state.value = minted.outcome === `denied` ? `denied` : `off`;
                return;
            }
            await sandboxJson(`/push/subscribe`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify(minted.channel),
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
            const id = await driver.localId();
            if (id !== null) {
                // Tell the daemon FIRST: if the local unregister succeeds and the daemon call then fails, the
                // daemon is left pushing at a dead channel (harmless — it prunes on refusal — but it would
                // keep reporting "on"). This order fails in the recoverable direction instead.
                await sandboxJson(`/push/unsubscribe`, jsonBody(`POST`, { id }));
                await driver.drop();
            }
            state.value = `off`;
        } catch (cause) {
            error.value = cause instanceof Error ? cause.message : `Could not turn notifications off.`;
            await refresh();
        } finally {
            busy.value = false;
        }
    };

    // An end-to-end proof of the chain: daemon key -> push service -> this device's OS. Not one of those hops
    // is visible from the settings page, and no status text can stand in for the thing itself, so the
    // button's whole value is that a notification either shows up on the device or it doesn't — provided it
    // also reports the half the user CAN'T see. The daemon answers with how many devices it reached and
    // errors on a zero, so "nothing appeared" now splits into "the daemon sent to nobody" (actionable, and it
    // says how) and "it sent to you and your OS didn't show it".
    const sendTest = async (): Promise<void> => {
        error.value = undefined;
        delivered.value = undefined;
        busy.value = true;
        try {
            delivered.value = (await sandboxJson<PushTest>(`/push/test`, { method: `POST` })).delivered;
        } catch (cause) {
            error.value = cause instanceof Error ? cause.message : `Could not send a test notification.`;
            // A push service that refuses a send makes the daemon drop that registration, so a failed test can
            // mean this device is no longer registered. Re-read instead of leaving a toggle reading "on" for a
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
     * read as the setting not being persisted — every reload showed the toggle off for a device that was in
     * fact registered, and turning it "on" again was really just the first read that ever succeeded. */
    watch(reachable, () => void refresh(), { immediate: true });

    return { state, busy, error, delivered, canToggle, enable, disable, sendTest, refresh };
}
