import type { MemberRole } from "@intentic/sandbox-contract";
import { call } from "@orpc/server";
import { unstubbed } from "@intentic/testing";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { createAuthConnections } from "../auth/connections.js";
import { createMediaTickets } from "../auth/tokens/media-tickets.js";
import { createWsTickets } from "../auth/tokens/ws-tickets.js";
import { memoryAreasStore, memoryMembersStore } from "../harness/route-stores.testing.js";
import { createAreasRoutes } from "./areas.routes.js";

// An area is a grant: moving its folders changes what its holders may read, so their open streams, filtered against
// the folders read when those opened, are closed to reconnect against the new ones.

// The owner saving from the Access screen, as the middleware hands the request on.
const asOwner: OrpcContext = {
    headers: new Headers(),
    method: "POST",
    url: "/areas/save",
    identity: { email: "owner@example.com", role: "owner" as MemberRole, methods: ["google"] },
};

const routes = () => {
    const connections = createAuthConnections();
    const revoked: (string | undefined)[] = [];
    connections.onRevoke((email) => revoked.push(email));
    const services = {
        areas: memoryAreasStore([{ id: "support", label: "Support", folders: ["support"] }]),
        members: memoryMembersStore([
            { email: "fay@example.com", role: "collaborator", areas: ["support"] },
            { email: "vic@example.com", role: "viewer" },
        ]),
        auth: unstubbed<NonNullable<Services["auth"]>>("auth", { connections }),
        wsTickets: createWsTickets(),
        mediaTickets: createMediaTickets(),
    };
    return { areas: createAreasRoutes(services), revoked, services };
};

test("moving an area's folders closes its holders' streams, and nobody else's", async () => {
    const { areas, revoked, services } = routes();
    const ticket = services.wsTickets.mint({ email: "fay@example.com", role: "collaborator" });
    await call(areas.save, { id: "support", label: "Support", folders: ["support", "faq"] }, { context: asOwner });
    expect(revoked).toEqual(["fay@example.com"]);
    // A ticket minted under the old folders opens nothing either.
    expect(services.wsTickets.redeem(ticket)).toBeUndefined();
});

test("moving an area's folders ends its holders' media tickets, and nobody else's", async () => {
    const { areas, services } = routes();
    const holder = services.mediaTickets.mint("support/clip.mp4", undefined, "fay@example.com").ticket;
    const other = services.mediaTickets.mint("support/clip.mp4", undefined, "vic@example.com").ticket;
    await call(areas.save, { id: "support", label: "Support", folders: ["faq"] }, { context: asOwner });
    expect(services.mediaTickets.bound(holder)).toBeUndefined();
    expect(services.mediaTickets.bound(other)).toBe("support/clip.mp4");
});

test("a relabel moves no folder and closes nothing", async () => {
    const { areas, revoked } = routes();
    await call(areas.save, { id: "support", label: "Customer support", folders: ["./support/"] }, { context: asOwner });
    expect(revoked).toEqual([]);
});
