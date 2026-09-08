import type { PushChannel, PushNotification } from "@intentic/sandbox-contract";

// What every transport owes push.ts's fan-out: one settled verdict per channel, never a rejection.
// `dead` means this channel can never be sent to again and the row must be forgotten; anything else is a transient to
// log and move past.

export interface SendOutcome {
    readonly delivered: boolean;
    // Permanently unreachable; the caller prunes the row instead of retrying forever.
    readonly dead?: boolean;
    // The transient's cause, for the log line; mutually exclusive with `dead`.
    readonly error?: unknown;
}

export type ChannelSend<C extends PushChannel = PushChannel> = (channel: C, notification: PushNotification) => Promise<SendOutcome>;

// Statuses both transports treat as permanent:
// 404/410: the device is gone (uninstalled, permission revoked, endpoint rotated).
// 403: the credential can never work again (retired VAPID key, revoked relay secret).
export const DEAD = new Set([403, 404, 410]);
