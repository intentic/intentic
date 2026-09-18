import { netdiskContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { tunnelEntry } from "../tunnel/tunnel-links.js";
import { heldStream } from "../tunnel/tunnel-route.js";
import { mountNetdisk, netdiskLink, netdiskLinks, unmountNetdisk } from "./netdisk-links.js";

// The live network-disk routes. Adding a disk is a capability add; MOUNTING one is here, because mounting is a runtime
// operation performed many times over one stored disk, by the operator from the card and by the agent through the
// `netdisk` CLI, which calls these same routes. Both therefore observe one implementation.

export type NetdiskRoutesDeps = Pick<Services, "capabilities">;

export const createNetdiskRoutes = (services: NetdiskRoutesDeps) => {
    const i = implement(netdiskContract).$context<OrpcContext>();
    const mounting = new Set<string>();

    const entryOf = async (id: string) => {
        const entry = await tunnelEntry(services.capabilities, "netdisk", id);
        if (entry === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `no netdisk capability with that id` });
        }
        return entry;
    };

    return {
        list: i.list.handler(async () => ({ links: await netdiskLinks(services.capabilities) })),
        mount: i.mount.handler(async function* ({ input }) {
            const entry = await entryOf(input.id);
            yield* heldStream(
                mounting,
                entry.id,
                "mounting",
                () => mountNetdisk(entry),
                async () => {
                    const link = await netdiskLink(entry);
                    return `${link.id}: ${link.state}${link.state === "mounted" ? ` · ${link.mountPoint} · ${link.writable === true ? "read-write" : "read-only"}` : ""}`;
                },
            );
        }),
        unmount: i.unmount.handler(async ({ input }) => {
            await unmountNetdisk(await entryOf(input.id));
            return { ok: true } as const;
        }),
    };
};
