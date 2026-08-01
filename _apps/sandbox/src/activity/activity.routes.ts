import { activityContract, type ActivityStatus } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { listenerProvidersOf } from "../extensions/installed-extensions.js";
import { listenerState } from "../extensions/listener-state.js";
import { listenerStatus } from "../extensions/listener-status.js";

type ActivityConnection = ActivityStatus["connections"][number];

// Resolve each connection the gateway pushed into what the panel renders: `idle` (no enabled listener automation,
// so the gateway is deliberately not connecting) overrides the pushed state, and lastError rides only a
// genuinely-down connection — idle/ready/connecting cards stay clean instead of inheriting a stale login error.
export const resolveConnections = (connections: ActivityConnection[], idle: boolean, lastError: string | undefined): ActivityConnection[] =>
    connections.map((connection) => {
        const gateway = idle ? "idle" : connection.gateway;
        return { ...connection, gateway, ...(gateway === "disconnected" && lastError !== undefined ? { lastError } : {}) };
    });

// One provider's live picture: what its gateway last pushed, resolved against whether it has anything to
// connect FOR and whatever it last failed with. Absent when no gateway reported within the TTL.
const providerStatus = async (services: Services, provider: string): Promise<ActivityStatus | undefined> => {
    const status = listenerStatus(provider, Date.now());
    if (status === undefined) {
        return undefined;
    }
    // No enabled listener automation for this provider ⇒ the gateway is deliberately not connecting (idle),
    // distinct from a connection that should be up but isn't. Derived here from the same listenerState the
    // gateway reconciles on — fresher than the gateway's ≤30s status snapshot.
    const idle = (await listenerState(services, provider)).automations.length === 0;
    // lastError: the newest system-error in the recent log (a gateway reports login failures via /failure,
    // which lands there). ponytail: provider-level scan (multiple bots share it).
    const recent = await services.activity.list({ provider, limit: 100 });
    const lastError = recent.find((event) => event.direction === "system" && event.error !== undefined)?.error;
    return { connections: resolveConnections(status.connections, idle, lastError), ...(status.voice !== undefined ? { voice: status.voice } : {}) };
};

// The activity audit feed. `list` reads the daemon-written log; `status` reports the realtime connection +
// voice health that the provider gateways (extension processes) push to /listeners/<provider>/status — the
// daemon holds no connection of its own to probe. Every listener provider an enabled extension declares is
// polled, not a hardcoded one: Discord, Slack and IMAP all report through the same routes, and a fourth
// gateway shipped as an extension shows up here with no change to this file.
export const createActivityRoutes = (services: Services) => {
    const i = implement(activityContract).$context<OrpcContext>();
    return {
        list: i.list.handler(async ({ input }) => ({ events: await services.activity.list(input) })),
        status: i.status.handler(async () => {
            const providers = [...(await listenerProvidersOf(services)).keys()];
            const reported = (await Promise.all(providers.map((provider) => providerStatus(services, provider)))).filter(
                (status) => status !== undefined,
            );
            // Voice is one session at a time across the sandbox (ext-discord holds it), so the first provider
            // reporting one owns the card.
            const voice = reported.find((status) => status.voice !== undefined)?.voice;
            return { connections: reported.flatMap((status) => status.connections), ...(voice !== undefined ? { voice } : {}) };
        }),
    };
};
