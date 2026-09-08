import type { PushChannel } from "@intentic/sandbox-contract";

// The seam between how a device receives push and everything else: usePushNotifications drives this interface,
// webPush.ts and nativePush.ts implement the transports, and neither imports the other's mechanics. Both sides speak
// one shared identity, the daemon's channelId (an endpoint or a deviceId), opaque to the composable.

// What minting produced. `denied` is terminal for the page (only the user can undo it in settings); `dismissed` is a
// closed prompt, nothing changed, ask again another day.
export type Minted = { outcome: "granted"; channel: PushChannel } | { outcome: "denied" } | { outcome: "dismissed" };

export interface PushDriver {
    // Whether this environment can deliver push at all, the settings page's `unsupported` state.
    readonly supported: () => boolean;
    // Whether the user has terminally blocked notifications here.
    readonly denied: () => Promise<boolean>;
    // The channel id this device currently holds, or null; validity unjudged, that's `bound`'s question.
    readonly localId: () => Promise<string | null>;
    // Whether the registration can still be sent to under the daemon's current key. The web driver checks against
    // `publicKey`'s VAPID pair; the native driver has no key, so a remembered registration always counts.
    readonly bound: (publicKey: string) => Promise<boolean>;
    // Asks permission and produces the channel; throws only on chain failure, a decline is an outcome not an error.
    // `publicKey` arrives as a supplier, since the web driver must ask before fetching it, inside the click.
    readonly mint: (publicKey: () => Promise<string>) => Promise<Minted>;
    // Undoes mint's local half; the daemon's row is removed first, so failure leaves only the recoverable side.
    readonly drop: () => Promise<void>;
}
