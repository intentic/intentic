import { channelId, pushContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";

export type PushRoutesDeps = Pick<Services, "push" | "pushSender">;

// The device's half of push: read the VAPID public key and this device's registration state, register, unregister, send
// a test. Every route identifies a device by channelId (a browser's endpoint or a native relay's deviceId); the daemon
// never invents that identity.
export const createPushRoutes = (services: PushRoutesDeps) => {
    const i = implement(pushContract).$context<OrpcContext>();
    return {
        config: i.config.handler(async ({ input }) => {
            const [keys, channels] = await Promise.all([services.push.keys(), services.push.list()]);
            return {
                publicKey: keys.publicKey,
                // Answered for the asking device specifically, so the toggle can tell "no row" apart from "granted but
                // not notified".
                subscribed: input.id !== undefined && channels.some((entry) => channelId(entry) === input.id),
            };
        }),
        subscribe: i.subscribe.handler(async ({ input }) => {
            await services.push.add(input);
            return { ok: true } as const;
        }),
        unsubscribe: i.unsubscribe.handler(async ({ input }) => {
            await services.push.remove(input.id);
            return { ok: true } as const;
        }),
        // Named `notify`, not `notifyIfAway`: pressing this test always sends, so a silent no-op would prove nothing.
        // Reports the delivered count and refuses OK on zero, since "no row" and "every send refused" look identical
        // otherwise.
        test: i.test.handler(async () => {
            const { delivered, failed } = await services.pushSender.notify({
                title: "intentic",
                body: "Notifications are working.",
                tag: "intentic-test",
            });
            if (delivered === 0) {
                throw new ORPCError("PRECONDITION_FAILED", {
                    message:
                        failed === 0
                            ? "No device is registered with this sandbox: turn the toggle off and on again to register this one."
                            : "Every registered device refused the send, so their registrations were dropped. Turn the toggle off and on again to re-register this device.",
                });
            }
            return { delivered };
        }),
    };
};
