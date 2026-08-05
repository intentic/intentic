import { oc } from "@orpc/contract";
import { OkSchema, PushConfigQuerySchema, PushConfigSchema, PushEndpointSchema, PushSubscriptionSchema, PushTestSchema } from "../schemas.js";

// Web-push notifications for this sandbox. The daemon owns the VAPID keypair and the subscription list (see
// push/push-store.ts for why the key lives on the history volume), and sends on the three moments where the
// operator's attention is genuinely wanted: a turn finished, the agent is blocked on an answer, and an
// automation is waiting for approval.
//
// `test` exists because a notification pipeline has four independent failure points the user cannot inspect
// (browser permission, service-worker registration, the daemon's key, the push service itself) — a button
// that proves the whole chain end-to-end is worth more than any amount of status rendering.
export const pushContract = {
    config: oc.route({ method: "GET", path: "/push/config" }).input(PushConfigQuerySchema).output(PushConfigSchema),
    subscribe: oc.route({ method: "POST", path: "/push/subscribe" }).input(PushSubscriptionSchema).output(OkSchema),
    unsubscribe: oc.route({ method: "POST", path: "/push/unsubscribe" }).input(PushEndpointSchema).output(OkSchema),
    test: oc.route({ method: "POST", path: "/push/test" }).output(PushTestSchema),
};
