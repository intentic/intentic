import { channelId, type PushNotification } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { idleEverywhere } from "../system/presence.js";
import type { PushStore } from "./push-store.js";
import { sendRelay } from "./senders/relay.js";
import type { SendOutcome } from "./senders/send.js";
import { sendWebPush } from "./senders/webpush.js";

/* Sending a notification to every device registered with this sandbox — browsers over web push, native
 * installs through the platform relay. The transports live in senders/ behind one outcome shape; this file
 * owns only the fan-out, the prune, and the two properties that matter more than any mechanics:
 *
 * 1. Never notify someone who is already looking. The daemon knows exactly who is connected and whether their
 *    tab is idle (presence.ts, fed by the /events stream), so a turn that finishes while the user is watching
 *    it finish sends nothing. Without this the feature is an irritation rather than a convenience.
 * 2. Never let a push failure touch the thing that triggered it. Every send is fire-and-forget from the
 *    caller's perspective: a turn must complete identically whether a push service is up, down, or slow. */

// How many devices a send actually reached. The turn lifecycle ignores it — a missed notification is never
// worth failing a turn over — but the settings page's test button has no other way to tell the user whether
// the chain it claims to prove is intact, and a silent zero is precisely the failure it exists to catch.
export interface PushDelivery {
    readonly delivered: number;
    readonly failed: number;
}

export interface PushSender {
    // Fan out to every registered device. Resolves once every send settles; never rejects — a failing device
    // is a logged warning, since callers get no say in the outcome and nothing to retry with.
    readonly notify: (notification: PushNotification) => Promise<PushDelivery>;
    // The same, but skipped entirely when anyone is actively watching this sandbox — nobody wants a phone
    // buzzing about a screen they are already looking at. This is what the turn lifecycle calls; `notify`
    // stays available for the settings page's explicit "send a test" button, which must fire even though the
    // user is by definition looking at the screen when they press it.
    readonly notifyIfAway: (notification: PushNotification) => Promise<PushDelivery>;
}

const NOTHING_SENT: PushDelivery = { delivered: 0, failed: 0 };

export const createPushSender = (store: PushStore, logger: Logger): PushSender => {
    const notify = async (notification: PushNotification): Promise<PushDelivery> => {
        const [keys, channels] = await Promise.all([store.keys(), store.list()]);
        if (channels.length === 0) {
            return NOTHING_SENT;
        }
        const webPush = sendWebPush(keys);
        // Fan out, don't chain: each channel stands alone, and one that hangs or 500s must not hold up or
        // abort the sends to every other device the user owns.
        const outcomes = await Promise.all(
            channels.map(async (channel) => {
                const outcome: SendOutcome =
                    channel.kind === "webpush" ? await webPush(channel, notification) : await sendRelay(channel, notification);
                const id = channelId(channel);
                // A dead channel has exactly one correct response: forget the row. Retrying forever would be
                // the bug, and keeping it would let the settings toggle keep claiming "on" for a device that
                // can no longer be reached.
                if (outcome.dead === true) {
                    await store.remove(id).catch(() => undefined);
                    logger.debug({ id, kind: channel.kind }, "push: dropped a channel we can no longer send to");
                }
                // Anything else is transient (a 5xx, a timeout). Warn and move on: there is nothing to retry
                // against, and a missed notification is never worth failing the caller over.
                if (outcome.dead !== true && outcome.error !== undefined) {
                    logger.warn({ err: outcome.error, id, kind: channel.kind }, "push: send failed");
                }
                return outcome.delivered;
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
