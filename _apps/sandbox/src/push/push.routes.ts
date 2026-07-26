import { pushContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// The browser's half of web push: read the VAPID public key (and whether THIS browser is already registered),
// register, unregister, and send a test. Subscribing is per-browser, so every route that identifies a device
// does it by the endpoint the browser's push service minted — the daemon never invents that identity.
export const createPushRoutes = (services: Services) => {
    const i = implement(pushContract).$context<OrpcContext>();
    return {
        config: i.config.handler(async ({ input }) => {
            const [keys, subscriptions] = await Promise.all([services.push.keys(), services.push.list()]);
            return {
                publicKey: keys.publicKey,
                // Answered for the asking browser specifically: a granted browser permission with no row here
                // would notify nothing, and the toggle must be able to tell those two states apart.
                subscribed: input.endpoint !== undefined && subscriptions.some((entry) => entry.endpoint === input.endpoint),
            };
        }),
        subscribe: i.subscribe.handler(async ({ input }) => {
            await services.push.add(input);
            return { ok: true } as const;
        }),
        unsubscribe: i.unsubscribe.handler(async ({ input }) => {
            await services.push.remove(input.endpoint);
            return { ok: true } as const;
        }),
        // Deliberately `notify`, not `notifyIfAway`: the user is by definition looking at the screen when they
        // press this, and a test that silently sends nothing would prove the opposite of what it claims.
        test: i.test.handler(async () => {
            await services.pushSender.notify({
                title: "intentic",
                body: "Notifications are working.",
                tag: "intentic-test",
            });
            return { ok: true } as const;
        }),
    };
};
