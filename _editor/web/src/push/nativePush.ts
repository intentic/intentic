import type { PushChannel } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/client";
import { pushPlugin, type PushNotificationsPlugin } from "../shell/capacitor.js";
import type { Minted, PushDriver } from "./driver.js";

// Loaded on use, not at module load: the platform client evaluates window.env on import, which only exists in
// a real page — and this module rides the composable's import graph into every environment, shell or not.
const platformApi = async () => (await import("../composables/useApi.js")).apiClient;

/* Push inside the native iOS shell. WKWebView has no web push, so the transport is APNs — and Apple only
 * accepts sends from the app's vendor, which is why this driver registers with the PLATFORM's push relay
 * rather than handing the daemon anything it could post to directly. The handshake:
 *
 *   shell → APNs token → relay register (signed-in) → {deviceId, secret, url} → stored on the DAEMON
 *
 * The channel the daemon stores is the relay's grant, verbatim. This device's id is the deviceId the relay
 * minted; it is remembered locally so the settings toggle can answer "is THIS phone registered" without a
 * platform round-trip on every refresh. */

// Rotates on every successful registration; holds only an id (never the secret — that goes to the daemon
// and exists nowhere else on this device).
const DEVICE_KEY = `intentic:push-device`;

// APNs answers a register() through a delayed event, not the call. Ten seconds is APNs being unreachable,
// not slow — surface it rather than leaving the toggle spinning forever.
const TOKEN_TIMEOUT_MS = 10_000;

const apnsToken = async (plugin: PushNotificationsPlugin): Promise<string> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`The push service did not answer. Check the phone's connection and try again.`)),
            TOKEN_TIMEOUT_MS,
        );
        const settle = (work: () => void) => {
            clearTimeout(timer);
            work();
        };
        void plugin.addListener(`registration`, (token) => settle(() => resolve(token.value)));
        void plugin.addListener(`registrationError`, (error) =>
            settle(() => reject(new Error(`The push service refused this device: ${error.error}`))),
        );
        plugin.register().catch((cause: unknown) => settle(() => reject(cause instanceof Error ? cause : new Error(String(cause)))));
    });

// The supplier is the web transport's key fetch; APNs has no equivalent and this driver never calls it.
const mint = async (_publicKey: () => Promise<string>): Promise<Minted> => {
    const plugin = pushPlugin();
    if (plugin === undefined) {
        throw new Error(`Notifications are not available in this app build.`);
    }
    const permission = await plugin.requestPermissions();
    if (permission.receive !== `granted`) {
        // iOS asks once: a decline IS the terminal denied state (there is no "dismissed" on the native
        // prompt — Settings is the only way back).
        return { outcome: `denied` };
    }
    const token = await apnsToken(plugin);
    try {
        const grant = await (await platformApi()).push.register({ platform: `ios`, token });
        localStorage.setItem(DEVICE_KEY, grant.deviceId);
        const channel: PushChannel = { kind: `relay`, url: grant.url, deviceId: grant.deviceId, secret: grant.secret };
        return { outcome: `granted`, channel };
    } catch (cause) {
        if (cause instanceof ORPCError && cause.status === 404) {
            throw new Error(`This platform has no push relay configured, so the app cannot receive notifications.`, { cause });
        }
        throw new Error(`Registering this device with the platform failed. Check the connection and try again.`, { cause });
    }
};

export const nativePushDriver: PushDriver = {
    supported: () => pushPlugin() !== undefined,
    denied: async () => (await pushPlugin()?.checkPermissions())?.receive === `denied`,
    // The relay grant is this device's registration; a cleared app storage reads as "off", and re-enabling
    // re-registers — the relay's (user, token) upsert makes that a replace, not a duplicate.
    localId: async () => localStorage.getItem(DEVICE_KEY),
    // No key in this transport (VAPID binding is a web-push concern): a remembered registration is sendable.
    bound: async () => localStorage.getItem(DEVICE_KEY) !== null,
    mint,
    drop: async () => {
        const deviceId = localStorage.getItem(DEVICE_KEY);
        localStorage.removeItem(DEVICE_KEY);
        if (deviceId !== null) {
            // Best-effort: the daemon row is already gone (the composable removes it first), so a relay row
            // left behind can send to nobody and the next register would replace it anyway.
            await (await platformApi()).push.unregister({ deviceId }).catch(() => undefined);
        }
    },
};
