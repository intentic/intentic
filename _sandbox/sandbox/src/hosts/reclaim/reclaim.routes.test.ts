import { systemContract } from "@intentic/sandbox-contract/contracts/system.contract";
import { memberRefusal } from "@intentic/sandbox-contract/protocol/member-reach";
import { routeAccess } from "@intentic/sandbox-contract/protocol/route-meta";
import type { MemoryReclaimResult } from "@intentic/sandbox-contract/schemas/metrics";
import { call } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { createReclaimRoutes } from "./reclaim.routes.js";

// POST /system/memory/reclaim, the composer's "Free memory": the press is the background reclaim's own
// (host-reclaim.ts, whose suite pins what it does), so the route hands its answer through as it is, to the owner alone.

const GIB = 1024 ** 3;

const asOwner: OrpcContext = {
    headers: new Headers(),
    method: "POST",
    url: "/system/memory/reclaim",
    identity: { email: "owner@example.com", tier: "owner", methods: ["host"] },
};

const routesAnswering = (answer: MemoryReclaimResult) => {
    let presses = 0;
    const routes = createReclaimRoutes({
        hostReclaim: {
            press: async () => {
                presses += 1;
                return answer;
            },
            available: () => true,
        },
    });
    return { routes, presses: () => presses };
};

test("a press answers what this sandbox let go and what the computer had before and after", async () => {
    const answer: MemoryReclaimResult = { outcome: "reclaimed", givenBytes: GIB, host: { name: "rog", beforeBytes: 4 * GIB, afterBytes: 5 * GIB } };
    const { routes, presses } = routesAnswering(answer);
    expect(await call(routes.reclaimMemory, undefined, { context: asOwner })).toEqual(answer);
    expect(presses()).toBe(1);
});

test("a refused press answers why, not an error", async () => {
    const { routes } = routesAnswering({ outcome: "refused", why: "no-host" });
    expect(await call(routes.reclaimMemory, undefined, { context: asOwner })).toEqual({ outcome: "refused", why: "no-host" });
});

test("only the owner reaches it, never a maintainer, an agent's token, a panel or a control token", () => {
    expect(memberRefusal({ tier: "maintainer" }, "POST", "/system/memory/reclaim")).toEqual({ error: "owner access required", floor: "owner", reason: "floor" });
    expect(memberRefusal({ tier: "owner" }, "POST", "/system/memory/reclaim")).toBeUndefined();
    expect(routeAccess("POST", systemContract.reclaimMemory["~orpc"].meta)).toMatchObject({
        auth: "session",
        floor: "owner",
        guest: false,
        agent: false,
        panel: false,
        control: "never",
    });
});
