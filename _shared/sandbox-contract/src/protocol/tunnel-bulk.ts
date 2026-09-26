import { RAW_ROUTE_LIST } from "./raw-routes.js";

// What the daemon announces to the edge as its transfers (RouteMeta `lane`), handed to the front with the tunnel's door
// and carried on each of its sockets' upgrades (the tunnel crate's `x-intentic-bulk`), so the edge sends a transfer
// down the bulk socket and a keystroke never queues behind it on one TCP connection. The edge compiles in nothing of it.
export const tunnelBulkRoutes = (): string[] =>
    RAW_ROUTE_LIST.filter(({ meta }) => meta.lane === "bulk").map(({ method, path }) => `${method} ${path}`);
