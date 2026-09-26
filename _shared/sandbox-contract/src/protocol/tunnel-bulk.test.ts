import { readFileSync } from "node:fs";
import { servedRoute } from "./routes.js";
import { RAW_ROUTE_LIST } from "./raw-routes.js";
import { hostOwnerId } from "./ingress-contract.js";
import { tunnelBulkRoutes } from "./tunnel-bulk.js";

// The shared fixture the edge reads too (the tunnel crate's bulk.rs): `bulk` is what the daemon announces, and every
// case is the lane the daemon's own router gives the request, which the edge's reading of `bulk` must match.
// SAFETY: the fixture is this repository's own file, and both tests below fail on a key it lacks.
const FIXTURE = JSON.parse(readFileSync(new URL("./ingress-contract.fixture.json", import.meta.url), "utf8")) as {
    readonly bulk: readonly string[];
    readonly lanes: readonly { readonly host: string; readonly method: string; readonly path: string; readonly lane: "interactive" | "bulk" }[];
};

// A preview's dev server rides bulk; a daemon request rides its route's lane, the route found as the router finds it.
const laneOf = (host: string, method: string, path: string): "interactive" | "bulk" => {
    const id = hostOwnerId(host);
    const label = host.split(":")[0]?.split(".")[0] ?? "";
    if (id === undefined || label !== `sandbox-${id}`) {
        return "bulk";
    }
    return servedRoute(RAW_ROUTE_LIST, [], method, path)?.meta.lane ?? "interactive";
};

test("the fixture's announcement is what the daemon announces today", () => {
    expect(tunnelBulkRoutes()).toEqual([...FIXTURE.bulk]);
    for (const route of tunnelBulkRoutes()) {
        expect(route).toMatch(/^[A-Z]+ \/\S*$/);
    }
});

test("every request the shared fixture names rides the lane the daemon's router gives it", () => {
    expect(FIXTURE.lanes.length).toBeGreaterThan(20);
    for (const { host, method, path, lane } of FIXTURE.lanes) {
        expect({ host, method, path, lane: laneOf(host, method, path) }).toEqual({ host, method, path, lane });
    }
});
