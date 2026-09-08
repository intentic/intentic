import { channelId, type PushNotification } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { idleEverywhere } from "../system/presence.js";
import type { PushStore } from "./push-store.js";
import { sendRelay } from "./senders/relay.js";
import type { SendOutcome } from "./senders/send.js";
import { sendWebPush } from "./senders/webpush.js";

// Fans out a notification to every registered device (browsers over web push, native installs through the relay);
// transports live in senders/ behind one outcome shape.
// 1. Never notifies someone already watching (presence.ts tracks idle tabs via the /events stream).
// 2. A push failure never touches the caller: every send is fire-and-forget.

// How many devices a send reached; the turn lifecycle ignores it, but the test button needs it to catch a silent zero.
export interface PushDelivery {
    readonly delivered: number;
    readonly failed: number;
}

export interface PushSender {
    // Resolves once every send settles; never rejects, a failing device is only a logged warning.
    readonly notify: (notification: PushNotification) => Promise<PushDelivery>;
    // Skipped while anyone is watching a screen; `notify` remains for the settings page's explicit test send.
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
        // Fans out independently: one channel that hangs or errors must not block sends to the others.
        const outcomes = await Promise.all(
            channels.map(async (channel) => {
                const outcome: SendOutcome =
                    channel.kind === "webpush" ? await webPush(channel, notification) : await sendRelay(channel, notification);
                const id = channelId(channel);
                // A dead channel is dropped rather than retried, so the toggle stops claiming a device that can't be
                // reached.
                if (outcome.dead === true) {
                    await store.remove(id).catch(() => undefined);
                    logger.debug({ id, kind: channel.kind }, "push: dropped a channel we can no longer send to");
                }
                // Any other failure is transient; log a warning and move on, not worth failing the caller over.
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
