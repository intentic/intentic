import type { PushChannel } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/client";
import { pushPlugin, type PushNotificationsPlugin } from "../shell/window/capacitor.js";
import type { Minted, PushDriver } from "./driver.js";

// Loaded on use, not at module load: the platform client reads window.env on import, which exists only in a real page,
// and this module rides the composable's import graph into every environment.
const platformApi = async () => (await import("../lib/useApi.js")).apiClient;

// Push inside the native iOS shell: WKWebView has no web push, so this driver registers with the platform's push relay,
// since Apple only accepts sends from the app's vendor. The stored channel is the relay's grant verbatim; the deviceId
// is remembered locally so the toggle can check registration without a round trip.

// Rotates on every registration; holds only an id, never the secret (that lives only on the daemon).
const DEVICE_KEY = `intentic:push-device`;

// APNs answers register() via a delayed event; 10s means unreachable, not slow, so the toggle stops spinning.
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
        // iOS asks once; a decline is the terminal denied state, only Settings gets you back.
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
    // Cleared storage reads as off; re-enabling re-registers, and the relay's upsert replaces it, not a dup.
    localId: async () => localStorage.getItem(DEVICE_KEY),
    // No key in this transport (VAPID binding is a web-push concern): a remembered registration is sendable.
    bound: async () => localStorage.getItem(DEVICE_KEY) !== null,
    mint,
    drop: async () => {
        const deviceId = localStorage.getItem(DEVICE_KEY);
        localStorage.removeItem(DEVICE_KEY);
        if (deviceId !== null) {
            // Best-effort: the daemon row is gone; a leftover relay row reaches nobody and gets replaced anyway.
            await (await platformApi()).push.unregister({ deviceId }).catch(() => undefined);
        }
    },
};
