import type { PushChannel, PushNotification } from "@intentic/sandbox-contract";

/* What every transport owes the fan-out in push.ts: one settled verdict per channel, never a rejection.
 * `dead` is the one distinction that changes daemon state — it means this channel can NEVER be sent to again
 * and the only correct response is to forget the row. Everything else is a transient the caller logs and
 * moves past, because a missed notification is never worth failing a turn over. */

export interface SendOutcome {
    readonly delivered: boolean;
    // Permanently unreachable — the caller prunes the row. Retrying forever would be the bug, and keeping it
    // would let the settings toggle keep claiming "on" for a device that can no longer be reached.
    readonly dead?: boolean;
    // The transient's cause, for the log line. Mutually exclusive with `dead` — a dead row needs no autopsy.
    readonly error?: unknown;
}

export type ChannelSend<C extends PushChannel = PushChannel> = (channel: C, notification: PushNotification) => Promise<SendOutcome>;

// The statuses both transports treat as permanent, by shared convention:
//   404/410 — the device is gone: app uninstalled, permission revoked, endpoint rotated.
//   403     — the credential presented can never work again (a retired VAPID key, a revoked relay secret).
// The relay answers with the same codes precisely so one set decides prunes everywhere.
export const DEAD = new Set([403, 404, 410]);
