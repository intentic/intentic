import { BoundedMap } from "@intentic/base/held";
import type { PushNotification, PushSentNotification } from "@intentic/sandbox-contract/schemas/push";

// What each notification said, kept so a native app whose push carried only the tag can ask for the words over its own
// session (GET /push/notification): the Android editor app's push passes through Google and the platform's relay, and
// neither is handed a word. Kept by tag, then by the member whose devices it was sent to, since a send skips the devices
// of whoever is looking: a later one under the same tag may reach Bob and not Ada, and Ada's phone still shows the one
// before it, so that is the one Ada is answered with.
// In memory only. A restart forgets every one, and the app then draws its own generic words.

// Tags kept; the oldest written goes first. Each holds one entry per member it reached, which a sandbox's roster bounds.
const TAGS_KEPT = 200;

// How long the words are kept: the relay holds an undelivered push for six hours, and a phone that wakes later still
// asks; past a day nothing is waiting on them and they are not kept longer than that.
const KEPT_MS = 24 * 60 * 60_000;

export interface SentNotifications {
    // Files a notification under its tag for each member its devices were sent to, before any send leaves, so an app
    // woken at once by its push never asks ahead of the record.
    readonly remember: (notification: PushNotification & { readonly tag: string }, members: Iterable<string>) => void;
    // The last one sent to this member under this tag, while kept; undefined for anything else, the member included.
    readonly read: (tag: string, member: string) => PushSentNotification | undefined;
}

export const createSentNotifications = (): SentNotifications => {
    const byTag = new BoundedMap<string, Map<string, PushSentNotification>>(TAGS_KEPT);
    return {
        remember: (notification, members) => {
            const reached = [...new Set([...members].map((member) => member.toLowerCase()))];
            if (reached.length === 0) {
                return;
            }
            const sent: PushSentNotification = { ...notification, sentAt: new Date().toISOString() };
            const held = byTag.get(notification.tag) ?? new Map<string, PushSentNotification>();
            for (const member of reached) {
                held.set(member, sent);
            }
            // Written again so this tag counts as the newest.
            byTag.set(notification.tag, held);
        },
        // A copy, so nothing a caller does to its answer reaches what is kept for the next one.
        read: (tag, member) => {
            const sent = byTag.get(tag)?.get(member.toLowerCase());
            return sent !== undefined && Date.now() - Date.parse(sent.sentAt) <= KEPT_MS ? { ...sent } : undefined;
        },
    };
};
