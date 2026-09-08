import { activityContract, type ActivityStatus } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { listenerProvidersOf } from "../extensions/installed-extensions.js";
import { listenerState } from "../extensions/listener-state.js";
import { listenerStatus } from "../extensions/listener-status.js";

type ActivityConnection = ActivityStatus["connections"][number];

// `idle` (no enabled listener automation) overrides the pushed gateway state; `lastError` attaches only to a
// disconnected connection, so idle/ready/connecting cards don't inherit a stale login error.
export const resolveConnections = (connections: ActivityConnection[], idle: boolean, lastError: string | undefined): ActivityConnection[] =>
    connections.map((connection) => {
        const gateway = idle ? "idle" : connection.gateway;
        return { ...connection, gateway, ...(gateway === "disconnected" && lastError !== undefined ? { lastError } : {}) };
    });

// One provider's live picture: what its gateway last pushed, resolved against whether it has anything to connect for
// and its last failure. Undefined when no gateway reported within the TTL.
const providerStatus = async (services: ActivityRoutesDeps, provider: string): Promise<ActivityStatus | undefined> => {
    const status = listenerStatus(provider, Date.now());
    if (status === undefined) {
        return undefined;
    }
    // No automation means idle (not connecting), distinct from down; fresher than the gateway's snapshot.
    const idle = (await listenerState(services, provider)).automations.length === 0;
    // Newest system-error in the log (login failures arrive via /failure), scanned per provider since bots share it.
    const recent = await services.activity.list({ provider, limit: 100 });
    const lastError = recent.find((event) => event.direction === "system" && event.error !== undefined)?.error;
    return { connections: resolveConnections(status.connections, idle, lastError), ...(status.voice !== undefined ? { voice: status.voice } : {}) };
};

export type ActivityRoutesDeps = Pick<Services, "activity" | "automations" | "capabilities" | "config" | "files" | "workspace">;

// `list` reads the daemon-written log; `status` aggregates connection/voice health that provider gateways push to
// /listeners/<provider>/status. Providers come from enabled extensions, not a hardcoded list.
export const createActivityRoutes = (services: ActivityRoutesDeps) => {
    const i = implement(activityContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async ({ input }) => ({ events: await services.activity.list(input) })),
        status: i.status.handler(async () => {
            const providers = [...(await listenerProvidersOf(services)).keys()];
            const reported = (await Promise.all(providers.map((provider) => providerStatus(services, provider)))).filter(
                (status) => status !== undefined,
            );
            // Voice is one session at a time (ext-discord holds it); the first provider reporting one owns the card.
            const voice = reported.find((status) => status.voice !== undefined)?.voice;
            return { connections: reported.flatMap((status) => status.connections), ...(voice !== undefined ? { voice } : {}) };
        }),
    };
};
