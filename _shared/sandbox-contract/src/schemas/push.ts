// push: notifications to the owner's devices
import { z } from "zod";
// The daemon is the only tier that knows what the agent is doing, so it is the sender. A registration is per-device, in
// two kinds:
// webpush: a browser (including the Android TWA); the daemon sends to its push service directly, end-to-end encrypted.
// relay: a native app (iOS); its OS push service only accepts sends from the vendor, so the daemon posts through a
// relay, which can read the payload.

// Exact shape `web-push` consumes, from `PushManager.subscribe()`; posted back verbatim.
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
export const RelayChannelSchema = z.object({
    kind: z
        .literal("relay")
        .describe(
            "A native app, whose operating system only accepts sends from the app's publisher, so the sandbox posts through a relay instead. The message passes through that relay readable, which is the price of the publisher having to be in the loop.",
        ),
    url: z.url().describe("Where to post a send. Recorded rather than assumed, so the sandbox need not know any platform by name."),
    deviceId: z.string().min(1).describe("The device's id, which also identifies this registration everywhere else in this group."),
    secret: z.string().min(1).describe("Proof that this sandbox may notify this device. The relay never learns which sandbox is calling."),
});
export type RelayChannel = z.infer<typeof RelayChannelSchema>;
export const PushChannelSchema = z.discriminatedUnion("kind", [WebPushChannelSchema, RelayChannelSchema]);
export type PushChannel = z.infer<typeof PushChannelSchema>;
// The one identity every push route uses (subscribe, unsubscribe, config); derived from the channel's own shape so the
// daemon and web app can't disagree about it.
export const channelId = (channel: PushChannel): string => (channel.kind === "webpush" ? channel.endpoint : channel.deviceId);
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
    requireInteraction: z
        .boolean()
        .optional()
        .describe(
            "Keep it on screen until it is dismissed. Used when the agent is waiting for you, where one that fades away is a question that went unanswered in silence.",
        ),
});
export type PushNotification = z.infer<typeof PushNotificationSchema>;
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
export const PushConfigQuerySchema = z.object({
    id: z
        .string()
        .min(1)
        .optional()
        .describe("Which device is asking. Without it the answer can only speak for the sandbox as a whole, which is rarely the question."),
});
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
