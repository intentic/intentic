import { portsContract, portUrl, zoneFromUrl } from "@intentic/sandbox-contract";
import { identifyPort } from "./port-identity.js";
import { extensionProcessIndex } from "../extensions/extension-processes.js";
import type { ExtensionHost } from "../extensions/installed-extensions.js";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";

// list scans procfs on demand, no background poller; forward/unforward drive the slot table. Forwarding is the explicit
// exposure gesture: a preview is public once forwarded; the daemon's own surfaces are never listed.

// ExtensionHost is only for naming a supervised service by its extension (port 40085 becomes "the discord extension's
// gateway", not `node dist/gateway.js`); narrowed rather than pulling in more of Services.
export type PortsRoutesDeps = Pick<Services, "config" | "portForwards" | "scanPorts" | "serviceProcesses" | "workspace"> &
    ExtensionHost;

export const createPortsRoutes = (services: PortsRoutesDeps) => {
    const i = implement(portsContract).$context<OrpcContext>();
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    // The daemon's own listeners (oRPC server, preview proxy, sshd); everything else is the user's to forward.
    const reserved = new Set([services.config.sandbox.port, services.config.preview.port, 22]);

    return {
        list: i.list.handler(async () => {
            const listeners = await services.scanPorts();
            // Read once for the whole list, not per row, to avoid re-reading the extensions directory per port. A
            // failure here costs one row's name, never the list, since the desktop mirror reconciles against this route
            // on a loop.
            const extensionProcesses = await extensionProcessIndex(services).catch(() => new Map());
            const servicePorts = new Map(services.serviceProcesses.list().map((service) => [service.port, service.key]));
            const attribution = { workspaceRoot: services.workspace.root, extensionProcesses, servicePorts };
            return {
                ports: listeners
                    .filter(({ port }) => !reserved.has(port))
                    .map((listener) => {
                        const slot = services.portForwards.slotOf(listener.port);
                        const url = slot !== undefined ? portUrl(slot, zone, sandboxId) : undefined;
                        const summary = Object.assign({ forwarded: slot !== undefined }, listener, identifyPort(listener, attribution));
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
            if (!listener.forwardable) {
                throw new ORPCError("BAD_REQUEST", { message: `port ${input.port} is bound to a loopback address the preview proxy can't reach` });
            }
            // The listener's dial host rides into the forward; a `localhost` bind can be ::1-only (Vite).
            const slot = await services.portForwards.forward(input.port, listener.host);
            const url = portUrl(slot, zone, sandboxId);
            return url === undefined ? {} : { previewUrl: url };
        }),
        unforward: i.unforward.handler(({ input }) => {
            services.portForwards.unforward(input.port);
            return { ok: true } as const;
        }),
    };
};
