import { vpnContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { tunnelEntry } from "../tunnel/tunnel-links.js";
import { heldStream } from "../tunnel/tunnel-route.js";
import { parseForticlientConfig } from "./forticlient-config.js";
import { connectVpn, disconnectVpn, vpnLink, vpnLinks } from "./vpn-links.js";

// The live VPN routes. Adding a VPN is a capability add; DIALLING one is here, because connecting is a runtime
// operation performed many times over one stored connection, by the operator from the VPN card and by the
// agent through the `vpn` CLI, which calls these same routes. Both therefore observe one implementation.

export type VpnRoutesDeps = Pick<Services, "capabilities">;

export const createVpnRoutes = (services: VpnRoutesDeps) => {
    const i = implement(vpnContract).$context<OrpcContext>();
    const dialling = new Set<string>();

    const entryOf = async (id: string) => {
        const entry = await tunnelEntry(services.capabilities, "vpn", id);
        if (entry === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `no vpn capability with that id` });
        }
        return entry;
    };

    return {
        list: i.list.handler(async () => ({ links: await vpnLinks(services.capabilities) })),
        connect: i.connect.handler(async function* ({ input }) {
            const entry = await entryOf(input.id);
            yield* heldStream(
                dialling,
                entry.id,
                "connecting",
                () => connectVpn(entry, { otp: input.otp }),
                async () => {
                    const link = await vpnLink(entry);
                    return `${link.id}: ${link.state}${link.address === undefined ? "" : ` · ${link.address}`}`;
                },
            );
        }),
        disconnect: i.disconnect.handler(async ({ input }) => {
            await disconnectVpn(await entryOf(input.id));
            return { ok: true } as const;
        }),
        importForticlient: i.importForticlient.handler(async ({ input }) => ({ connections: parseForticlientConfig(input.xml) })),
    };
};
