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

// A subscription we can never send to again. Two permanent outcomes, both normal:
//   404/410 — the endpoint is gone: the browser was uninstalled, the permission revoked, the endpoint rotated.
//   403     — the endpoint is alive but was minted for a DIFFERENT VAPID key. This is the easier one to miss,
//             and it happens whenever the sandbox is recreated: push-store mints a fresh keypair while browsers
//             keep subscriptions bound to the old one. Our key never rotates back, so this endpoint will refuse
//             every send forever.
// Either way the only correct response is to forget the row — retrying forever would be the bug, and keeping it
// would let the settings toggle keep claiming "on" for a device that can no longer be reached.
const DEAD = new Set([403, 404, 410]);

// How many devices a send actually reached. The turn lifecycle ignores it — a missed notification is never
// worth failing a turn over — but the settings page's test button has no other way to tell the user whether
// the chain it claims to prove is intact, and a silent zero is precisely the failure it exists to catch.
export interface PushDelivery {
    readonly delivered: number;
    readonly failed: number;
}

export interface PushSender {
    // Fan out to every subscribed device. Resolves once every send settles; never rejects.
    readonly notify: (notification: PushNotification) => Promise<PushDelivery>;
    // The same, but skipped entirely when anyone is actively watching this sandbox. This is what the turn
    // lifecycle calls; `notify` stays available for the settings page's explicit "send a test" button, which
    // must fire even though the user is by definition looking at the screen when they press it.
    readonly notifyIfAway: (notification: PushNotification) => Promise<PushDelivery>;
}

const NOTHING_SENT: PushDelivery = { delivered: 0, failed: 0 };

export const createPushSender = (store: PushStore, logger: Logger): PushSender => {
    const notify = async (notification: PushNotification): Promise<PushDelivery> => {
        const [keys, subscriptions] = await Promise.all([store.keys(), store.list()]);
        if (subscriptions.length === 0) {
            return NOTHING_SENT;
        }
        // `mailto:` is required by the VAPID spec as the contact a push service can reach; it is never sent
        // anywhere else and identifies the software, not the user (the daemon has no address of its own).
        webpush.setVapidDetails("mailto:agent@intentic.dev", keys.publicKey, keys.privateKey);
        const payload = JSON.stringify(notification);
        // Every device is independent — one failing endpoint must not delay or cancel the others.
        const outcomes = await Promise.all(
            subscriptions.map(async (subscription) => {
                try {
                    await webpush.sendNotification(subscription, payload, { TTL: 600 });
                    return true;
                } catch (error) {
                    if (error instanceof WebPushError && DEAD.has(error.statusCode)) {
                        await store.remove(subscription.endpoint).catch(() => undefined);
                        logger.debug(
                            { endpoint: subscription.endpoint, statusCode: error.statusCode },
                            "push: dropped a subscription we can no longer send to",
                        );
                        return false;
                    }
                    // Anything else is transient (a 5xx, a timeout). Warn and move on: there is nothing to
                    // retry against, and a missed notification is never worth failing the caller over.
                    logger.warn({ err: error, endpoint: subscription.endpoint }, "push: send failed");
                    return false;
                }
            }),
        );
        const delivered = outcomes.filter(Boolean).length;
        return { delivered, failed: outcomes.length - delivered };
    };

    return {
        notify,
        notifyIfAway: async (notification) => {
            if (!idleEverywhere()) {
                return NOTHING_SENT;
            }
            return notify(notification);
        },
    };
};
