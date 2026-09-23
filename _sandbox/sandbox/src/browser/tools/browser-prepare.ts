import { rawRoutePath } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { z } from "zod";
import { bearerFrom, tokenEquals } from "../../auth/auth.js";
import type { Services } from "../../composition.js";
import { profileOwner } from "../sessions/session-store.js";
import { ANONYMOUS_BROWSER_SERVER, type PrepareBridge, prepareBrowserOwner } from "./browser-tools.js";

// The router's door back into this daemon: it holds a manifest of owners it may reach, but none of the machinery to
// bring one up (display allocation is serialized here, and fingerprints, exits and profile locks are this process's
// state). It asks, the daemon does the work, the router spawns what comes back.

// Points a router at this daemon, carrying the per-boot bridge token; loopback, like every other bridge the agent's
// own processes dial.
export const browserPrepareBridge = (services: Pick<Services, "config" | "browserBridgeToken">): PrepareBridge => ({
    url: `http://127.0.0.1:${services.config.sandbox.port}${rawRoutePath("POST /system/browser/prepare")}`,
    token: services.browserBridgeToken,
});

const askSchema = z.object({ owner: z.string().min(1), port: z.number().int().positive().max(65_535) });

// A door (sandbox-contract raw-routes.ts), checking the bridge token itself like the peer MCP bridges.
export const createBrowserPrepareRoute =
    (services: Pick<Services, "browserBridgeToken" | "capabilities" | "workspace">) =>
    async (c: Context): Promise<Response> => {
        if (!tokenEquals(bearerFrom(c.req.header("authorization")), services.browserBridgeToken)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const ask = askSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!ask.success) {
            return c.json({ error: "owner and port required" }, 400);
        }
        const { owner, port } = ask.data;
        const capabilities = await services.capabilities.list();
        // Second gate, not the only one: the turn's own manifest already limits which owners its router may ask for,
        // and this limits the ask to profiles the sandbox actually holds, so a leaked token can't name a path.
        const known =
            owner === ANONYMOUS_BROWSER_SERVER ||
            capabilities.some((capability) => (capability.kind === "browser" || capability.kind === "identity") && profileOwner(capability) === owner);
        if (!known) {
            return c.json({ refusal: `no browser profile named "${owner}" in this sandbox` });
        }
        return c.json(await prepareBrowserOwner(capabilities, services.workspace.root, owner, port));
    };
