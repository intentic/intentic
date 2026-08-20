import type { PushChannel } from "@intentic/sandbox-contract";

/* The seam between "how this device receives push" and everything else. usePushNotifications owns the flow,
 * permission, daemon round-trips, the settings page's states, against exactly this interface; webPush.ts
 * and nativePush.ts own the transports. Neither side imports the other's mechanics, which is what keeps a
 * browser build free of shell knowledge and the shell path free of service-worker knowledge.
 *
 * The one identity both sides speak is the daemon's channelId: the endpoint a browser's push service minted,
 * or the deviceId a native registration minted. The composable never looks inside it. */

// What minting produced. `denied` is terminal for the page (only the user can undo it in settings);
// `dismissed` is a closed prompt, nothing changed, ask again another day.
export type Minted = { outcome: "granted"; channel: PushChannel } | { outcome: "denied" } | { outcome: "dismissed" };

export interface PushDriver {
    // Whether this environment can deliver push at all, the settings page's `unsupported` state.
    readonly supported: () => boolean;
    // Whether the user has terminally blocked notifications here.
    readonly denied: () => Promise<boolean>;
    // The channel id this device currently holds a registration under, or null, validity unjudged (that is
    // `bound`'s question). What the composable hands the daemon's config probe as "this device is asking".
    readonly localId: () => Promise<string | null>;
    /* Whether the local registration can still be SENT to under the daemon's current key. The web driver
     * answers by comparing the subscription's VAPID binding against `publicKey`: a recreated sandbox mints a
     * fresh pair, and an endpoint bound to the old one refuses every send while a toggle would happily report
     * "on". The native driver has no key in its transport, a remembered registration is a sendable one. */
    readonly bound: (publicKey: string) => Promise<boolean>;
    /* Ask permission and produce the channel to store on the daemon. Throws only when the CHAIN failed
     * (with advice worth showing); a user saying no is an outcome, not an error.
     *
     * The daemon's key arrives as a SUPPLIER, not a value, because ordering differs by transport and the
     * permission prompt must stay inside the user's click: the web driver asks permission FIRST (Safari
     * spends the gesture on any awaited fetch) and only then fetches the key to subscribe with; the native
     * driver's transport has no key and never calls it. */
    readonly mint: (publicKey: () => Promise<string>) => Promise<Minted>;
    // Undo mint's local half. The daemon's row is the composable's to remove, ordering matters there
    // (daemon first, so a failure leaves the recoverable side inconsistent), so the composable owns it.
    readonly drop: () => Promise<void>;
}
