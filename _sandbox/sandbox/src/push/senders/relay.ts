import { type PushNotification, type RelayChannel, RelayGoneSchema } from "@intentic/sandbox-contract/schemas/push";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";
import type { ChannelSend } from "./send.js";

/* The relay transport: a native install's OS push service (APNs) only accepts sends from the app's vendor. */

// A hung relay must not hold the turn's other sends hostage, the fan-out in push.ts awaits every outcome.
const SEND_TIMEOUT_MS = 10_000;

// A relay from before the marker said a dead device only with its own 410, whose oRPC body names the code.
const OlderRelayGoneSchema = z.object({ code: z.literal("GONE") });

// Whether the relay itself said this channel will never deliver again, which is the only answer that forgets it: its
// marker (sandbox-contract RELAY_CHANNEL_GONE) on whatever status, or an older relay's own 410. A bare 403 or 404 is not
// enough, unlike web push's (webpush.ts): the relay sits behind the platform's proxy, and a platform that is down
// answers those as an HTML page or Cloudflare's, which would unregister every phone for an outage.
export const relaySaysGone = (status: number, body: string): boolean =>
    parseJsonWith(body, RelayGoneSchema) !== undefined || (status === 410 && parseJsonWith(body, OlderRelayGoneSchema) !== undefined);

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
        // allow(silent-catch): a body that cannot be read says nothing the relay meant, so the status alone is logged.
        const body = await response.text().catch(() => "");
        if (relaySaysGone(response.status, body)) {
            return { delivered: false, dead: true };
        }
        return { delivered: false, error: new Error(`relay answered ${response.status}`) };
    } catch (error) {
        return { delivered: false, error };
    }
};
