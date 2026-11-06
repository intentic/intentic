import { insidePath, isSandboxPage, legacyTarget, topPath } from "@intentic/sandbox-contract/app-routes";
import { channelId, type PushNotification, type PushSentNotification } from "@intentic/sandbox-contract/schemas/push";
import { roleAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import type { Logger } from "pino";
import type { Caller } from "../auth/auth.js";
import { visibleTo } from "../auth/fleet-scope.js";
import { idleEverywhere, presentMembers } from "../system/presence.js";
import type { Audience } from "./push-audience.js";
import type { PushStore, StoredChannel } from "./push-store.js";
import { createSentNotifications } from "./sent-notifications.js";
import { sendRelay } from "./senders/relay.js";
import type { SendOutcome } from "./senders/send.js";
import { sendWebPush } from "./senders/webpush.js";

// Fans out a notification to the registered devices (browsers over web push, native installs through the relay);
// transports live in senders/ behind one outcome shape.
// 1. Only the devices of the people it is for (push-audience.ts): each device's person as the roster admits them now, so
//    a person taken off the roster hears nothing more, and never a person the conversation it is about is hidden from.
// 2. Never notifies someone already watching (presence.ts tracks idle tabs via the /events stream): a device is skipped
//    while the member who registered it has a tab in use, and one that names no member while anybody does.
// 3. A push failure never touches the caller: every send is fire-and-forget.
// 4. What each tagged notification said is kept for the members it was sent to (sent-notifications.ts), for a native app
//    whose push carried only the tag.

// How many devices a send reached; the turn lifecycle ignores it, but the test button needs it to catch a silent zero.
export interface PushDelivery {
    readonly delivered: number;
    readonly failed: number;
    // Why nothing was sent, when nothing was: no device registered, or every device's person is at a screen.
    // Or a card night hours answered as it was raised, which waits on nobody (agent/night).
    readonly skipped?: "no device registered" | "nobody it is for has a device" | "everyone is watching" | "it never showed" | "night hours answered it";
}

// Who each device's person is as the roster admits them now (auth/members/member-caller.ts rosterCaller), read per send.
export interface PushRoster {
    readonly callerOf: (email: string) => Caller | undefined;
}

export interface PushSender {
    // To the devices of the people `to` names whether or not they are at a screen: a card that insists, a watch whose
    // whole answer is this push, a disk about to fill. Resolves once every send settles; never rejects, a failing device
    // is only a logged warning.
    readonly notify: (notification: PushNotification, to: Audience) => Promise<PushDelivery>;
    // The same, skipping the devices of whoever is watching a screen.
    readonly notifyIfAway: (notification: PushNotification, to: Audience) => Promise<PushDelivery>;
    // The settings page's test: this person's own devices (a device naming no one, for a caller with no identity).
    readonly test: (notification: PushNotification, member: string | undefined) => Promise<PushDelivery>;
    // Replaces an ask that stopped waiting (answered here or elsewhere, stopped) under its tag, on exactly the devices
    // its persistent notification reached: none at all when it never showed, so a settled ask never pushes on its own.
    readonly withdraw: (replacement: PushNotification & { readonly tag: string }) => Promise<PushDelivery>;
    // The last notification under this tag that was sent to this member's devices, while it is kept: the words a native
    // app's push left out. Undefined for any tag none of their devices was sent.
    readonly sent: (tag: string, member: string) => PushSentNotification | undefined;
}

const NOTHING_SENT: PushDelivery = { delivered: 0, failed: 0 };

// Whether a device belongs to somebody `to` is for. A device naming no member (registered before devices named theirs,
// or by the owner's own tool on loopback) is nobody's in particular: it hears the sandbox's own news, which is its
// owner's, and nothing about a conversation. A named one is its person's, as the roster admits them now, and only when
// the conversation it is about is shown to them.
const reachedBy = (to: Audience, roster: PushRoster): ((channel: StoredChannel) => boolean) => {
    const named = to.kind === "people" ? new Set(to.emails) : undefined;
    return (channel) => {
        if (channel.member === undefined) {
            return to.kind === "operators";
        }
        const caller = roster.callerOf(channel.member);
        if (caller === undefined) {
            return false;
        }
        const theirs = named === undefined ? roleAtLeast(caller.role, "maintainer") : named.has(channel.member.toLowerCase());
        return theirs && (to.about === undefined || visibleTo(caller, to.about));
    };
};

// Whether a device's person is away, as presence stands now. Its member decides for it; a device naming none cannot be
// matched to a tab, so it waits until every tab is idle.
const awayNow = (): ((channel: StoredChannel) => boolean) => {
    const present = presentMembers();
    const nobodyWatching = idleEverywhere();
    return (channel) => (channel.member === undefined ? nobodyWatching : !present.has(channel.member.toLowerCase()));
};

// What a native install's notification may say: the relay hands its title and body to Apple in plain text, through the
// platform, so while the privacy shield is on the personal data in them is replaced by what kind it was. Web push is
// encrypted to the browser end to end and goes as written.
export type PushRedaction = (text: string) => Promise<string>;

// A conversation's link as notifications.ts writes one (the editor's conversation-link guard reads `?conversation=`):
// its query and anchor, when the address is the app's root and names a conversation.
const conversationLinkOf = (url: string): string | undefined => {
    const read = new URL(url, "http://push.invalid");
    return read.pathname === topPath("root") && read.searchParams.has("conversation") ? `${read.search}${read.hash}` : undefined;
};

/**
 * Where a tap opens, once the daemon knows its own platform id (`sandbox`, the row its announce was answered with,
 * store/platform-row.ts; never the tunnel id of its connect token, which no reader's list names it by): a page of the sandbox,
 * written as every notification writes one (notifications.ts, the address before frames), is placed inside THIS sandbox
 * (`/s/<id>/…`), so the tap opens it whichever sandbox the reader had open last. A conversation's link goes to this
 * sandbox the same way (`/s/<id>?conversation=`), where the conversation-link guard reads the sandbox off the route. An
 * account page and anything else the table does not read go as written, as every notification does from a daemon that
 * does not know its id.
 */
export const placedIn =
    (sandbox: string | undefined) =>
    (notification: PushNotification): PushNotification => {
        if (sandbox === undefined || notification.url === undefined) {
            return notification;
        }
        const conversation = conversationLinkOf(notification.url);
        if (conversation !== undefined) {
            return { ...notification, url: `${insidePath(sandbox)}${conversation}` };
        }
        const target = legacyTarget(notification.url);
        return target === undefined || !isSandboxPage(target.link.page) ? notification : { ...notification, url: insidePath(sandbox, target.link) };
    };

// The platform's id for this sandbox when one is known, read per notification since the announce learns it after boot. One
// that cannot be read leaves the tap where the notification wrote it, the sandbox opened last.
const platformIdOf = async (sandbox: (() => Promise<string | undefined>) | undefined, logger: Logger): Promise<string | undefined> => {
    try {
        return await sandbox?.();
    } catch (error) {
        logger.warn({ err: error }, "push: this sandbox's platform id could not be read, the tap opens the sandbox open last");
        return undefined;
    }
};

export const createPushSender = (
    store: PushStore,
    logger: Logger,
    roster: () => Promise<PushRoster>,
    redact?: PushRedaction,
    sandbox?: () => Promise<string | undefined>,
): PushSender => {
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
    const sentWords = createSentNotifications();
    // Sends to every registered device `meant` keeps that `away` also keeps (presence, read as the send is asked for).
    const send = async (asked: PushNotification, meant: (channel: StoredChannel) => boolean, away: (channel: StoredChannel) => boolean = () => true): Promise<PushDelivery> => {
        const notification = placedIn(await platformIdOf(sandbox, logger))(asked);
        const [keys, registered] = await Promise.all([store.keys(), store.list()]);
        const theirs = registered.filter(meant);
        const channels = theirs.filter(away);
        if (channels.length === 0) {
            const skipped = registered.length === 0 ? "no device registered" : theirs.length === 0 ? "nobody it is for has a device" : "everyone is watching";
            return { ...NOTHING_SENT, skipped };
        }
        if (notification.tag !== undefined) {
            // The words as written, never the relay's redacted copy: they are read back over the member's own session.
            sentWords.remember(
                { ...notification, tag: notification.tag },
                channels.flatMap((channel) => (channel.member === undefined ? [] : [channel.member])),
            );
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

    const meantFor = async (to: Audience): Promise<(channel: StoredChannel) => boolean> => reachedBy(to, await roster());
    return {
        notify: async (notification, to) => send(notification, await meantFor(to)),
        // Presence is read as the notification is asked for, not once the store answers.
        notifyIfAway: async (notification, to) => {
            const away = awayNow();
            return send(notification, await meantFor(to), away);
        },
        test: (notification, member) => send(notification, (channel) => (member === undefined ? channel.member === undefined : channel.member?.toLowerCase() === member.toLowerCase())),
        withdraw: async (replacement) => {
            const reached = shown.get(replacement.tag);
            if (reached === undefined) {
                return { ...NOTHING_SENT, skipped: "it never showed" };
            }
            shown.delete(replacement.tag);
            // Never persistent and never a buzz, whatever the caller built: a withdrawal that stayed would be the stale
            // ask again, and one that sounded would call someone back to a phone for news that needs nothing of them.
            return send({ ...replacement, requireInteraction: false, silent: true }, (channel) => reached.has(channelId(channel)));
        },
        sent: sentWords.read,
    };
};
