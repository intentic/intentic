// push: notifications to the owner's devices
import { z } from "zod";
// The daemon is the only tier that knows what the agent is doing, so it is the sender. A registration is
// per-DEVICE and comes in two kinds, distinguished by who can be posted to directly:
//   webpush  a browser (including the Android TWA, which IS Chrome). The endpoint is minted by that
//            browser's push service and the daemon sends to it directly, end-to-end encrypted.
//   relay    a native app install (the iOS shell), whose OS push service (APNs) only accepts sends from
//            the app's vendor. The daemon posts plain JSON to the platform's push relay, which holds the
//            vendor credential and forwards. The payload transits the relay readable, the price of Apple
//            requiring the vendor in the loop, which is why the channel records WHERE to post (`url`)
//            rather than the daemon knowing any platform by name.
// Channels live here and not on the platform because the daemon is on the command path: the platform would
// have to be told about every turn to be useful.

// A browser's PushSubscription, in the exact shape `web-push` consumes, the browser produces it via
// PushManager.subscribe() and the client posts it back verbatim, so the daemon never reshapes it.
export const WebPushChannelSchema = z.object({
    kind: z.literal("webpush").describe("A browser, which the sandbox can reach directly and encrypt end to end."),
    endpoint: z.url().describe("Where that browser's push service accepts sends. It also identifies the device everywhere else in this group."),
    keys: z
        .object({
            p256dh: z.string().min(1).describe("The browser's public key, for encrypting what is sent."),
            auth: z.string().min(1).describe("The browser's secret, for the same."),
        })
        .describe("What the browser handed you when it subscribed. Post it back exactly as it came; nothing reshapes it."),
});
export type WebPushChannel = z.infer<typeof WebPushChannelSchema>;
// A native install, addressed through a push relay. `secret` is the send capability the relay minted at
// registration, the daemon proves it may notify this device by presenting it; the relay never learns which
// sandbox is calling. `deviceId` doubles as the channel's identity (see channelId below).
export const RelayChannelSchema = z.object({
    kind: z
        .literal("relay")
        .describe(
            "A native app, whose operating system only accepts sends from the app's publisher, so the sandbox posts through a relay instead. The message passes through that relay readable, which is the price of the publisher having to be in the loop.",
        ),
    // The absolute URL the daemon POSTs a send to, minted by the relay at registration, stored verbatim.
    url: z.url().describe("Where to post a send. Recorded rather than assumed, so the sandbox need not know any platform by name."),
    deviceId: z.string().min(1).describe("The device's id, which also identifies this registration everywhere else in this group."),
    secret: z.string().min(1).describe("Proof that this sandbox may notify this device. The relay never learns which sandbox is calling."),
});
export type RelayChannel = z.infer<typeof RelayChannelSchema>;
export const PushChannelSchema = z.discriminatedUnion("kind", [WebPushChannelSchema, RelayChannelSchema]);
export type PushChannel = z.infer<typeof PushChannelSchema>;
// The one identity every push route speaks: subscribe upserts by it, unsubscribe and the config probe name
// devices by it. Shape-derived so the daemon and the web app can never disagree about what identifies a row,
// a browser is its push endpoint, a native install is the deviceId its relay registration minted.
export const channelId = (channel: PushChannel): string => (channel.kind === "webpush" ? channel.endpoint : channel.deviceId);
// What the service worker renders. `url` is the in-app route the notification opens (the click handler
// focuses an existing tab there rather than spawning a new one); `tag` collapses repeats, a second
// "waiting on you" for the same conversation REPLACES the first instead of stacking. Push payloads are
// capped by the push services themselves (~4KB after encryption), which is why nothing here carries a
// transcript or a diff, the notification is a pointer back into the workspace, not a delivery mechanism
// for content.
export const PushNotificationSchema = z.object({
    title: z.string().min(1).describe("The headline."),
    body: z
        .string()
        .describe(
            "The line under it. Push services cap the whole payload at a few kilobytes, which is why nothing here carries a transcript or a diff: a notification is a pointer back, not a delivery.",
        ),
    url: z.string().optional().describe("Where tapping it goes. An existing tab is focused rather than a new one opened."),
    tag: z
        .string()
        .optional()
        .describe("Collapses repeats: a second notification with the same tag replaces the first instead of stacking beside it."),
    // Whether the notification stays on screen until dismissed. Set for the "agent is blocked on you" cases,
    // where a notification that auto-dismisses is a request that silently went unanswered.
    requireInteraction: z
        .boolean()
        .optional()
        .describe(
            "Keep it on screen until it is dismissed. Used when the agent is waiting for you, where one that fades away is a question that went unanswered in silence.",
        ),
});
export type PushNotification = z.infer<typeof PushNotificationSchema>;
// The VAPID public key a browser needs to subscribe (native shells ignore it), plus whether the asking
// device's channel is already known, so the settings toggle can render its true state instead of trusting
// the device's permission alone (a granted permission with no daemon-side row would notify nothing).
export const PushConfigSchema = z.object({
    publicKey: z.string().describe("The key a browser needs in order to subscribe. Native apps ignore it."),
    subscribed: z
        .boolean()
        .describe(
            "Whether the asking device is already registered, so a toggle can show its real state instead of trusting the device's own permission, which can be granted with nothing behind it.",
        ),
});
export const PushChannelIdSchema = z.object({
    id: z.string().min(1).describe("Which device: a browser's push address, or a native install's device id."),
});
// The optional `id` says WHICH device is asking (see channelId); without it `subscribed` could only speak
// for the sandbox as a whole, which is never the question the settings toggle needs answered.
export const PushConfigQuerySchema = z.object({
    id: z
        .string()
        .min(1)
        .optional()
        .describe("Which device is asking. Without it the answer can only speak for the sandbox as a whole, which is rarely the question."),
});
// What a test send actually achieved. `{ ok: true }` would be a lie the one place it matters most: the button
// exists to prove a chain the user cannot inspect, so "the daemon accepted the request" is not the answer to
// the question being asked. A count separates "your OS swallowed it" from "nothing was sent at all".
export const PushTestSchema = z.object({
    delivered: z
        .number()
        .int()
        .nonnegative()
        .describe(
            "How many devices actually accepted it. A count rather than a yes, because this button exists to prove a chain nobody can inspect, and the sandbox having accepted the request is not the question being asked.",
        ),
});
export type PushTest = z.infer<typeof PushTestSchema>;
