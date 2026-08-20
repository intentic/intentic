import type { PushNotification, WebPushChannel } from "@intentic/sandbox-contract";
import webpush, { WebPushError } from "web-push";
import { DEAD, type ChannelSend } from "./send.js";

/* The web-push transport: the daemon posts the encrypted payload straight to the endpoint the browser's push
 * service minted, signed with this sandbox's VAPID key. No third party of ours in the loop, this is the
 * end-to-end-encrypted half of the split described in PushChannelSchema. */

// 403 has a transport-specific meaning worth naming: the endpoint is alive but was minted for a DIFFERENT
// VAPID key. This is the easier one to miss, and it happens whenever the sandbox is recreated: push-store
// mints a fresh keypair while browsers keep subscriptions bound to the old one. Our key never rotates back,
// so this endpoint will refuse every send forever, a dead row like any 404/410.
export const sendWebPush =
    (keys: { publicKey: string; privateKey: string }): ChannelSend<WebPushChannel> =>
    async (channel: WebPushChannel, notification: PushNotification) => {
        // `mailto:` is required by the VAPID spec as the contact a push service can reach; it is never sent
        // anywhere else and identifies the software, not the user (the daemon has no address of its own).
        webpush.setVapidDetails("mailto:agent@intentic.dev", keys.publicKey, keys.privateKey);
        try {
            const { endpoint, keys: encryption } = channel;
            await webpush.sendNotification({ endpoint, keys: encryption }, JSON.stringify(notification), { TTL: 600 });
            return { delivered: true };
        } catch (error) {
            if (error instanceof WebPushError && DEAD.has(error.statusCode)) {
                return { delivered: false, dead: true };
            }
            return { delivered: false, error };
        }
    };
