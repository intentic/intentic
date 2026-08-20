import { oc } from "@orpc/contract";
import { OkSchema, PushChannelIdSchema, PushChannelSchema, PushConfigQuerySchema, PushConfigSchema, PushTestSchema } from "../schemas.js";

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
    config: oc.route({ method: "GET", path: "/push/config" }).input(PushConfigQuerySchema).output(PushConfigSchema),
    subscribe: oc.route({ method: "POST", path: "/push/subscribe" }).input(PushChannelSchema).output(OkSchema),
    unsubscribe: oc.route({ method: "POST", path: "/push/unsubscribe" }).input(PushChannelIdSchema).output(OkSchema),
    test: oc.route({ method: "POST", path: "/push/test" }).output(PushTestSchema),
};
