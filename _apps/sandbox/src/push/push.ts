import type { PushNotification } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import webpush, { WebPushError } from "web-push";
import { idleEverywhere } from "../system/presence.js";
import type { PushStore } from "./push-store.js";

/* Sending a notification to every device that subscribed to this sandbox.
 *
 * Two properties matter more than the mechanics:
 *
 * 1. Never notify someone who is already looking. The daemon knows exactly who is connected and whether their
 *    tab is idle (presence.ts, fed by the /events stream), so a turn that finishes while the user is watching
 *    it finish sends nothing. Without this the feature is an irritation rather than a convenience.
 * 2. Never let a push failure touch the thing that triggered it. Every send is fire-and-forget from the
 *    caller's perspective: a turn must complete identically whether the push service is up, down, or slow. */

// A dead subscription is a normal, permanent outcome — the browser was uninstalled, the permission revoked,
// the endpoint rotated. The push services signal it with these codes, and the only correct response is to
// forget the row (retrying forever would be the bug).
const GONE = new Set([404, 410]);

export interface PushSender {
    // Fan out to every subscribed device. Resolves once every send settles; never rejects.
    readonly notify: (notification: PushNotification) => Promise<void>;
    // The same, but skipped entirely when anyone is actively watching this sandbox. This is what the turn
    // lifecycle calls; `notify` stays available for the settings page's explicit "send a test" button, which
    // must fire even though the user is by definition looking at the screen when they press it.
    readonly notifyIfAway: (notification: PushNotification) => Promise<void>;
}

export const createPushSender = (store: PushStore, logger: Logger): PushSender => {
    const notify = async (notification: PushNotification): Promise<void> => {
        const [keys, subscriptions] = await Promise.all([store.keys(), store.list()]);
        if (subscriptions.length === 0) {
            return;
        }
        // `mailto:` is required by the VAPID spec as the contact a push service can reach; it is never sent
        // anywhere else and identifies the software, not the user (the daemon has no address of its own).
        webpush.setVapidDetails("mailto:agent@intentic.dev", keys.publicKey, keys.privateKey);
        const payload = JSON.stringify(notification);
        // Every device is independent — one failing endpoint must not delay or cancel the others.
        await Promise.all(
            subscriptions.map(async (subscription) => {
                try {
                    await webpush.sendNotification(subscription, payload, { TTL: 600 });
                } catch (error) {
                    if (error instanceof WebPushError && GONE.has(error.statusCode)) {
                        await store.remove(subscription.endpoint).catch(() => undefined);
                        logger.debug({ endpoint: subscription.endpoint }, "push: dropped a dead subscription");
                        return;
                    }
                    // Anything else is transient (a 5xx, a timeout). Warn and move on: there is nothing to
                    // retry against, and a missed notification is never worth failing the caller over.
                    logger.warn({ err: error, endpoint: subscription.endpoint }, "push: send failed");
                }
            }),
        );
    };

    return {
        notify,
        notifyIfAway: async (notification) => {
            if (!idleEverywhere()) {
                return;
            }
            await notify(notification);
        },
    };
};
