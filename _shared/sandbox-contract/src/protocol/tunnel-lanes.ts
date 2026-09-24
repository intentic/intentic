import { sandboxSubdomain } from "../ids/hostnames.js";
import { hostOwnerId } from "./ingress-contract.js";
import { RAW_ROUTE_LIST } from "./raw-routes.js";
import { servedRoute } from "./routes.js";

// Each sandbox dials two tunnels, and each browser request rides one, so a transfer never queues a keystroke, a call or
// an event frame behind it on one TCP connection. The front dials both (_sandbox/front tunnel.rs); the edge
// (_platform/ingress lanes.rs) picks by the table this file emits, and falls back to the other lane while the one picked
// is not held.

export type TunnelLane = "interactive" | "bulk";

// Names a tunnel's lane on its upgrade; a tunnel that names none is the interactive one.
export const INGRESS_LANE_HEADER = "x-intentic-lane";

export const tunnelLaneNamed = (header: string | string[] | undefined): TunnelLane => (header === "bulk" ? "bulk" : "interactive");

// A preview's dev server (every label but the daemon's own) is bulk: a page load is hundreds of requests and its assets
// can be large. The daemon's routes are interactive unless their policy says otherwise (RouteMeta `lane`).
export const tunnelLaneOf = (host: string, method: string, path: string): TunnelLane => {
    const id = hostOwnerId(host);
    const label = host.split(":")[0]?.split(".")[0] ?? "";
    if (id === undefined || label !== sandboxSubdomain(id)) {
        return "bulk";
    }
    return servedRoute(RAW_ROUTE_LIST, [], method, path)?.meta.lane ?? "interactive";
};

// The raw routes in registration order with the lane each rides: what the Rust edge matches a daemon request against,
// written to tunnel-lanes.json by scripts/write-lanes.mjs since the edge cannot run this file.
export const tunnelLaneTable = (): { readonly method: string; readonly path: string; readonly lane: TunnelLane }[] =>
    RAW_ROUTE_LIST.map(({ method, path, meta }) => ({ method, path, lane: meta.lane ?? "interactive" }));
