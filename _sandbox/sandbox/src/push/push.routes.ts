import { channelId, pushContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

export type PushRoutesDeps = Pick<Services, "push" | "pushSender">;

// The device's half of push: read the VAPID public key (and whether THIS device is already registered),
// register, unregister, and send a test. Registering is per-device, so every route that identifies one does
// it by channelId, the endpoint a browser's push service minted, or the deviceId a native install's relay
// registration minted. The daemon never invents that identity.
export const createPushRoutes = (services: PushRoutesDeps) => {
    const i = implement(pushContract).$context<OrpcContext>();
    return {
        config: i.config.handler(async ({ input }) => {
            const [keys, channels] = await Promise.all([services.push.keys(), services.push.list()]);
            return {
                publicKey: keys.publicKey,
                // Answered for the asking device specifically: a granted permission with no row here would
                // notify nothing, and the toggle must be able to tell those two states apart.
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
        // Deliberately `notify`, not `notifyIfAway`: the user is by definition looking at the screen when they
        // press this, and a test that silently sends nothing would prove the opposite of what it claims.
        //
        // Which is also why it reports the delivery count and refuses to answer OK on a zero. The two ways this
        // reaches nobody are the two the user cannot see and cannot tell apart from a working send that their
        // OS quietly dropped: no row at all (this device never registered, or its row was pruned as dead), and
        // a row every push service refused. Both used to return `{ ok: true }` to a page that then said nothing.
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
                            ? "No device is registered with this sandbox — turn the toggle off and on again to register this one."
                            : "Every registered device refused the send, so their registrations were dropped. Turn the toggle off and on again to re-register this device.",
                });
            }
            return { delivered };
        }),
    };
};
