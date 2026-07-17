import { activityContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { listenerState } from "../extensions/listener-state.js";
import { listenerStatus } from "../extensions/listener-status.js";

// The agent-activity audit feed. `list` reads the daemon-written log; `status` reports the realtime connection +
// voice health that the provider gateways (extension processes) push to /listeners/<provider>/status — the daemon
// holds no connection of its own to probe. An empty result means no gateway has reported within the TTL.
export const createActivityRoutes = (services: Services) => {
    const i = implement(activityContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async ({ input }) => ({ events: await services.activity.list(input) })),
        status: i.status.handler(async () => {
            const status = listenerStatus("discord", Date.now());
            if (status === undefined) {
                return { connections: [] };
            }
            // No enabled discord listener automation ⇒ the gateway is deliberately not connecting (idle),
            // distinct from a connection that should be up but isn't. Derived here from the same listenerState
            // the gateway reconciles on — fresher than the gateway's ≤30s status snapshot.
            const idle = (await listenerState(services, "discord")).automations.length === 0;
            // Overlay lastError from the recent activity log (the gateway reports login failures via /failure,
            // which lands there). ponytail: provider-level from a recent-log scan (multiple bots share it).
            const recent = await services.activity.list({ provider: "discord", limit: 100 });
            const lastError = recent.find((event) => event.direction === "system" && event.error !== undefined)?.error;
            const connections = status.connections.map((connection) => {
                const gateway = idle ? "idle" : connection.gateway;
                // Only a genuinely-down connection carries the error; idle/ready/connecting cards stay clean.
                return { ...connection, gateway, ...(gateway === "disconnected" && lastError !== undefined ? { lastError } : {}) };
            });
            return { connections, ...(status.voice !== undefined ? { voice: status.voice } : {}) };
        }),
    };
};
