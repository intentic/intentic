import { channelId, type PushNotification } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { idleEverywhere, presentMembers } from "../system/presence.js";
import type { PushStore, StoredChannel } from "./push-store.js";
import { sendRelay } from "./senders/relay.js";
import type { SendOutcome } from "./senders/send.js";
import { sendWebPush } from "./senders/webpush.js";

// Fans out a notification to the registered devices (browsers over web push, native installs through the relay);
// transports live in senders/ behind one outcome shape.
// 1. Never notifies someone already watching (presence.ts tracks idle tabs via the /events stream): a device is skipped
//    while the member who registered it has a tab in use, and one that names no member while anybody does.
// 2. A push failure never touches the caller: every send is fire-and-forget.

// How many devices a send reached; the turn lifecycle ignores it, but the test button needs it to catch a silent zero.
export interface PushDelivery {
    readonly delivered: number;
    readonly failed: number;
}

export interface PushSender {
    // Resolves once every send settles; never rejects, a failing device is only a logged warning.
    readonly notify: (notification: PushNotification) => Promise<PushDelivery>;
    // Skips the devices of whoever is watching a screen; `notify` remains for the settings page's explicit test send.
    readonly notifyIfAway: (notification: PushNotification) => Promise<PushDelivery>;
    // Replaces an ask that stopped waiting (answered here or elsewhere, stopped) under its tag, on exactly the devices
    // its persistent notification reached: none at all when it never showed, so a settled ask never pushes on its own.
    readonly withdraw: (replacement: PushNotification & { readonly tag: string }) => Promise<PushDelivery>;
}

const NOTHING_SENT: PushDelivery = { delivered: 0, failed: 0 };

// Whether a device is one whose person is away, as presence stands now. Its member decides for it; a device naming none
// cannot be matched to a tab, so it keeps the sandbox-wide rule and waits until every tab is idle.
const awayNow = (): ((channel: StoredChannel) => boolean) => {
    const present = presentMembers();
    const nobodyWatching = idleEverywhere();
    return (channel) => (channel.member === undefined ? nobodyWatching : !present.has(channel.member.toLowerCase()));
};

// What a native install's notification may say: the relay hands its title and body to Apple in plain text, through the
// platform, so while the privacy shield is on the personal data in them is replaced by what kind it was. Web push is
// encrypted to the browser end to end and goes as written.
export type PushRedaction = (text: string) => Promise<string>;

export const createPushSender = (store: PushStore, logger: Logger, redact?: PushRedaction): PushSender => {
    const forRelay = async (notification: PushNotification): Promise<PushNotification> => {
        if (redact === undefined) {
            return notification;
        }
        try {
            return { ...notification, title: (await redact(notification.title)) || notification.title, body: await redact(notification.body) };
        } catch (error) {
            // Unreadable shield policy: the words that could not be checked are left out rather than sent as they are.
            logger.warn({ err: error }, "push: the privacy shield could not check a notification, sending it without its words");
            return { ...notification, title: "Intentic", body: "" };
        }
    };
    // Which devices each persistent ask (`requireInteraction`) reached, by tag: the only notifications that stay on a lock
    // screen until tapped, so the only ones a withdrawal has to replace. Kept in memory: an ask pushed before a restart
    // stays until it is tapped, which is how every ask behaved before withdrawal existed.
    const shown = new Map<string, Set<string>>();
    // Sends to every registered device `wanted` keeps.
    const send = async (notification: PushNotification, wanted: (channel: StoredChannel) => boolean): Promise<PushDelivery> => {
        const [keys, registered] = await Promise.all([store.keys(), store.list()]);
        const channels = registered.filter(wanted);
        if (channels.length === 0) {
            return NOTHING_SENT;
        }
        const webPush = sendWebPush(keys);
        const relayed = channels.some((channel) => channel.kind !== "webpush") ? await forRelay(notification) : notification;
        // Fans out independently: one channel that hangs or errors must not block sends to the others.
        const outcomes = await Promise.all(
            channels.map(async (channel) => {
                const outcome: SendOutcome =
                    channel.kind === "webpush" ? await webPush(channel, notification) : await sendRelay(channel, relayed);
                const id = channelId(channel);
                // A dead channel is dropped rather than retried, so the toggle stops claiming a device that can't be
                // reached.
                if (outcome.dead === true) {
                    await store.remove(id).then(
                        () => logger.debug({ id, kind: channel.kind }, "push: dropped a channel we can no longer send to"),
                        (error: unknown) => logger.warn({ err: error, id, kind: channel.kind }, "push: could not drop a channel we can no longer send to"),
                    );
                }
                // Any other failure is transient; log a warning and move on, not worth failing the caller over.
                if (outcome.dead !== true && outcome.error !== undefined) {
                    logger.warn({ err: outcome.error, id, kind: channel.kind }, "push: send failed");
                }
                if (outcome.delivered && notification.requireInteraction === true && notification.tag !== undefined) {
                    shown.set(notification.tag, (shown.get(notification.tag) ?? new Set()).add(id));
                }
                return outcome.delivered;
            }),
        );
        const delivered = outcomes.filter(Boolean).length;
        return { delivered, failed: outcomes.length - delivered };
    };

    return {
        notify: (notification) => send(notification, () => true),
        // Presence is read as the notification is asked for, not once the store answers.
        notifyIfAway: (notification) => send(notification, awayNow()),
        withdraw: async (replacement) => {
            const reached = shown.get(replacement.tag);
            if (reached === undefined) {
                return NOTHING_SENT;
            }
            shown.delete(replacement.tag);
            // Never persistent itself, whatever the caller built: a withdrawal that stayed would be the stale ask again.
            return send({ ...replacement, requireInteraction: false }, (channel) => reached.has(channelId(channel)));
        },
    };
};
