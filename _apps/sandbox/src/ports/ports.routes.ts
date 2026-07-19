import { portLabel, portsContract, portUrl, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// The /ports routes: `list` scans procfs on demand (no background poller — the Ports view polls while open),
// `forward`/`unforward` drive the slot table. Forwarding is the explicit exposure gesture: previews are
// public, so a port is reachable from outside only after the owner (or an agent acting for them) forwards it —
// and the daemon's own surfaces are never listed or forwardable at all.

export const createPortsRoutes = (services: Services) => {
    const i = implement(portsContract).$context<OrpcContext>();
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    // The daemon's own listeners: the oRPC server, the preview proxy, and the container sshd. Everything else —
    // including docker-proxy ports for containers the workspace published — is the user's to forward.
    const reserved = new Set([services.config.sandbox.port, services.config.preview.port, 22]);

    return {
        list: i.list.handler(async () => {
            const listeners = await services.scanPorts();
            return {
                ports: listeners
                    .filter(({ port }) => !reserved.has(port))
                    .map((listener) => {
                        const slot = services.portForwards.slotOf(listener.port);
                        const url = slot !== undefined ? portUrl(slot, zone, sandboxId) : undefined;
                        const summary = Object.assign({ forwarded: slot !== undefined }, listener);
                        return url === undefined ? summary : Object.assign(summary, { previewUrl: url });
                    }),
            };
        }),
        forward: i.forward.handler(async ({ input }) => {
            if (reserved.has(input.port)) {
                throw new ORPCError("BAD_REQUEST", { message: `port ${input.port} belongs to the sandbox itself and can't be forwarded` });
            }
            const listener = (await services.scanPorts()).find(({ port }) => port === input.port);
            if (listener === undefined) {
                throw new ORPCError("NOT_FOUND", { message: `nothing is listening on port ${input.port}` });
            }
            // The listener's dial host rides into the forward: a `localhost` bind can be ::1-only (Vite).
            const slot = await services.portForwards.forward(input.port, listener.host);
            // Almost always a memoized no-op: the boot sweep pre-mints every slot label (and own-Cloudflare
            // rides its wildcard), so this only pays a platform call if boot ran with the platform unreachable.
            await services.ensurePreviewRoutes([portLabel(slot)]);
            const url = portUrl(slot, zone, sandboxId);
            return url === undefined ? {} : { previewUrl: url };
        }),
        unforward: i.unforward.handler(({ input }) => {
            services.portForwards.unforward(input.port);
            return { ok: true } as const;
        }),
    };
};
