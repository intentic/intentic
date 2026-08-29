import { oc } from "@orpc/contract";
import { PushChannelIdSchema, PushChannelSchema, PushConfigQuerySchema, PushConfigSchema, PushTestSchema } from "../schemas/push.js";
import { OkSchema } from "../schemas/shared.js";

// Push notifications for this sandbox. The daemon owns the VAPID keypair and the channel list (see
// push/push-store.ts for why the key lives on the history volume), and sends on the three moments where the
// operator's attention is genuinely wanted: a turn finished, the agent is blocked on an answer, and an
// automation is waiting for approval. A channel is either a browser's web-push subscription or a native
// install reached through the platform's push relay, see PushChannelSchema for the split and why.
//
// `test` exists because a notification pipeline has four independent failure points the user cannot inspect
// (device permission, service-worker or shell registration, the daemon's key, the push service itself), a
// button that proves the whole chain end-to-end is worth more than any amount of status rendering.
export const pushContract = {
    config: oc
        .route({
            method: "GET",
            path: "/push/config",
            summary: "What a device needs to subscribe",
            description: "The public key and settings a browser or app needs before it can register for notifications from this sandbox.",
        })
        .input(PushConfigQuerySchema)
        .output(PushConfigSchema),
    subscribe: oc
        .route({
            method: "POST",
            path: "/push/subscribe",
            summary: "Send notifications to this device",
            description:
                "Registers one device. The sandbox only interrupts you on the three moments where attention is genuinely wanted: a turn has finished, the agent is stuck on a question, and something is waiting for approval.",
        })
        .input(PushChannelSchema)
        .output(OkSchema),
    unsubscribe: oc
        .route({
            method: "POST",
            path: "/push/unsubscribe",
            summary: "Stop notifying a device",
            description: "Removes one registered device. Others keep receiving.",
        })
        .input(PushChannelIdSchema)
        .output(OkSchema),
    test: oc
        .route({
            method: "POST",
            path: "/push/test",
            summary: "Send a test notification",
            description:
                "Proves the whole chain end to end. Worth having, because there are four separate places a notification can be lost that nobody can inspect from the outside: the device's permission, its registration, the sandbox's key, and the delivery service.",
        })
        .output(PushTestSchema),
};
