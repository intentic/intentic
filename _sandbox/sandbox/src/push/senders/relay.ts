import type { PushNotification, RelayChannel } from "@intentic/sandbox-contract";
import { DEAD, type ChannelSend } from "./send.js";

/* The relay transport: a native install's OS push service (APNs) only accepts sends from the app's vendor. */

// A hung relay must not hold the turn's other sends hostage, the fan-out in push.ts awaits every outcome.
const SEND_TIMEOUT_MS = 10_000;

export const sendRelay: ChannelSend<RelayChannel> = async (channel: RelayChannel, notification: PushNotification) => {
    try {
        const response = await fetch(channel.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ deviceId: channel.deviceId, secret: channel.secret, notification }),
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (response.ok) {
            return { delivered: true };
        }
        if (DEAD.has(response.status)) {
            return { delivered: false, dead: true };
        }
        return { delivered: false, error: new Error(`relay answered ${response.status}`) };
    } catch (error) {
        return { delivered: false, error };
    }
};
