import { type RawRouteKey, rawRoutePath } from "@intentic/sandbox-contract";
import type { Handler, Hono } from "hono";
import type { AppEnv } from "../app-env.js";

// The one way a raw (non-oRPC) route is added to the app: under its declaration in RAW_ROUTES, which carries its
// policy, so the daemon serves no route without one. A `{param}` is spelled Hono's way, `:param`, on the way in.
export const rawRouteServer =
    (app: Hono<AppEnv>) =>
    (key: RawRouteKey, handler: Handler<AppEnv>): void => {
        app.on(key.slice(0, key.indexOf(" ")), rawRoutePath(key).replace(/\{([^}]+)\}/gu, ":$1"), handler);
    };
