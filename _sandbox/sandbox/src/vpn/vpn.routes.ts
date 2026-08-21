import { vpnContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { parseForticlientConfig } from "./forticlient-config.js";
import { connectVpn, disconnectVpn, vpnLink, vpnLinks } from "./vpn-links.js";

// The live VPN routes. Adding a VPN is a capability add; DIALLING one is here, because connecting is a runtime
// operation performed many times over one stored connection, by the operator from the Status card and by the
// agent through the `vpn` CLI, which calls these same routes. Both therefore observe one implementation.

export type VpnRoutesDeps = Pick<Services, "capabilities">;

export const createVpnRoutes = (services: VpnRoutesDeps) => {
    const i = implement(vpnContract).$context<OrpcContext>();
    // One dial per id at a time: two concurrent connects would race the same interface and leave a half-built
    // tunnel behind. Rejecting the second is honest, the first is already streaming its progress.
    const dialling = new Set<string>();

    const entryOf = async (id: string) => {
        const capability = await services.capabilities.get(id);
        if (capability === undefined || capability.kind !== "vpn") {
            throw new ORPCError("NOT_FOUND", { message: `no vpn capability with that id` });
        }
        return { id: capability.id, config: capability.config };
    };

    return {
        list: i.list.handler(async () => ({ links: await vpnLinks(services.capabilities) })),
        connect: i.connect.handler(async function* ({ input }) {
            const entry = await entryOf(input.id);
            if (dialling.has(entry.id)) {
                throw new ORPCError("CONFLICT", { message: `"${entry.id}" is already connecting, wait for it to finish` });
            }
            dialling.add(entry.id);
            try {
                yield* connectVpn(entry, { otp: input.otp });
                // The link's own state is the useful terminal frame: the caller (Status card or CLI) renders the
                // assigned address and routes without a second round-trip.
                const link = await vpnLink(entry);
                yield { kind: "log", message: `${link.id}: ${link.state}${link.address === undefined ? "" : ` · ${link.address}`}` };
                yield { kind: "result", ok: true };
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                yield { kind: "error", message };
                throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
            } finally {
                dialling.delete(entry.id);
            }
        }),
        disconnect: i.disconnect.handler(async ({ input }) => {
            await disconnectVpn(await entryOf(input.id));
            return { ok: true } as const;
        }),
        importForticlient: i.importForticlient.handler(async ({ input }) => ({ connections: parseForticlientConfig(input.xml) })),
    };
};
