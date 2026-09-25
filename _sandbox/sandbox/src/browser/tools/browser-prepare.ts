import { rawRoutePath } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import { bearerFrom, tokenEquals } from "../../auth/auth.js";
import type { Services } from "../../composition.js";
import { profileOwner } from "../sessions/session-store.js";
import { type BrowserRouterHub, createBrowserRouterHub, type Prepared, type RpcMessage } from "./browser-router.js";
import { ANONYMOUS_BROWSER_SERVER, browserToolSchemas, prepareBrowserOwner } from "./browser-tools.js";

// The daemon's side of every turn's browser routers: bringing one owner up on the first call that names it, and the
// HTTP door the agent's MCP client reaches a router through. The routers run here rather than as a process per
// session since display allocation, fingerprints, exits and profile locks are all this process's state anyway.

// Second gate, not the only one: a turn's manifest already limits which owners its router may ask for, and this limits
// the ask to profiles the sandbox actually holds, so no manifest can name a path.
export const prepareKnownOwner = async (services: Pick<Services, "capabilities" | "workspace">, owner: string, port: number): Promise<Prepared> => {
    const capabilities = await services.capabilities.list();
    const known =
        owner === ANONYMOUS_BROWSER_SERVER ||
        capabilities.some((capability) => (capability.kind === "browser" || capability.kind === "identity") && profileOwner(capability) === owner);
    if (!known) {
        return { refusal: `no browser profile named "${owner}" in this sandbox` };
    }
    return prepareBrowserOwner(capabilities, services.workspace.root, owner, port);
};

// Loopback, like every other bridge the agent's own processes dial; each router carries its own bearer. Services are
// read lazily, since the hub is one of them.
export const createBrowserRouters = (services: () => Pick<Services, "capabilities" | "config" | "workspace">): BrowserRouterHub =>
    createBrowserRouterHub({
        baseUrl: () => `http://127.0.0.1:${services().config.sandbox.port}${rawRoutePath("POST /mcp/browser/{id}").replace("/{id}", "")}`,
        router: { toolSchemas: browserToolSchemas, prepare: (owner, port) => prepareKnownOwner(services(), owner, port) },
        tokenEquals,
    });

// Streamable HTTP, answered as plain JSON: nothing a router says is server-initiated, so there is no stream to open.
export const createBrowserMcpRoute =
    (services: Pick<Services, "browserRouters">) =>
    async (c: Context): Promise<Response> => {
        const router = services.browserRouters.find(c.req.param("id") ?? "", bearerFrom(c.req.header("authorization")));
        if (router === undefined) {
            // One answer for a wrong token and an ended turn alike, so a guess learns nothing about which ids exist.
            return c.json({ error: "no such browser router" }, 404);
        }
        if (c.req.method === "GET") {
            return c.json({ error: "this endpoint has no server-initiated stream" }, 405);
        }
        if (c.req.method === "DELETE") {
            // A client ending its session is not the turn ending: a resumed client reconnects to the same router.
            return c.body(null, 204);
        }
        const payload = (await c.req.json().catch(() => undefined)) as RpcMessage | RpcMessage[] | undefined;
        if (payload === undefined || payload === null) {
            return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid json" } }, 400);
        }
        const signal = c.req.raw.signal;
        if (Array.isArray(payload)) {
            const answers = (await Promise.all(payload.map((message) => router.handle(message, signal)))).filter(
                (answer): answer is RpcMessage => answer !== undefined,
            );
            return answers.length === 0 ? c.body(null, 202) : c.json(answers);
        }
        const answer = await router.handle(payload, signal);
        return answer === undefined ? c.body(null, 202) : c.json(answer);
    };
