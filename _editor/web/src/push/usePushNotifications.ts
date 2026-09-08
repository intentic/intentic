import type { PushConfig } from "@intentic/api-contract";
import type { PushTest } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { nativePushDriver } from "./nativePush";
import { webPushDriver } from "./webPush";
import { inNativeShell } from "../shell/window/capacitor";
import { jsonBody } from "../features/sandbox/client/jsonBody";
import { sandboxJson } from "../features/sandbox/client/sandboxClient";
import { useSandbox } from "../features/sandbox/client/useSandbox";

// Push, from the device's side: HOW it is received is the driver's business; this composable owns the enabling chain
// (transport, permission, registration, daemon-stored) and reports which link failed, since `denied` is terminal.
// Per-device and per-sandbox: enabling on a laptop says nothing about a phone.

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
    // How many devices the last test reached; undefined until sent, telling a swallowed push from one never sent.
    const delivered = ref<number | undefined>(undefined);
    const canToggle = computed(() => state.value !== `unsupported` && state.value !== `denied` && !busy.value && reachable.value);

    // Bumped by every action so a slow, in-flight `refresh` can detect it is stale and skip writing.
    let revision = 0;

    // Establish what is actually true, from all three sources at once: the permission granted here, the registration
    // this device is holding, and whether the daemon has a row for it.
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
            // All three must agree before reporting on; any single mismatch would silently claim a dead chain works.
            state.value = id !== null && config.subscribed && (await driver.bound(config.publicKey)) ? `on` : `off`;
        } catch {
            // An unreadable daemon says nothing new; keep the last known state through a transient blip.
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
                // Daemon first: reversed, a failed daemon call after a successful local drop would still report on.
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

    // An end-to-end proof of the chain (daemon, push service, device OS) no status text can replace. The daemon's
    // delivered count splits 'nothing appeared' into 'sent to nobody' vs 'sent, but the OS did not show it'.
    const sendTest = async (): Promise<void> => {
        error.value = undefined;
        delivered.value = undefined;
        busy.value = true;
        try {
            delivered.value = (await sandboxJson<PushTest>(`/push/test`, { method: `POST` })).delivered;
        } catch (cause) {
            error.value = cause instanceof Error ? cause.message : `Could not send a test notification.`;
            // A refused send makes the daemon drop the registration; re-read rather than leave the toggle on.
            await refresh();
        } finally {
            busy.value = false;
        }
    };

    // Reconciles on mount and every time the daemon reconnects, not mount alone: the page can mount before the daemon
    // answers, and a `refresh` landing in that gap has nobody to ask, leaving `state` stuck at its initial `off`.
    watch(reachable, () => void refresh(), { immediate: true });

    return { state, busy, error, delivered, canToggle, enable, disable, sendTest, refresh };
}
