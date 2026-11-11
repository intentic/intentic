import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { MountCall } from "../../agent/tools/turn-mounts.routes.js";
import { forwardHeaders, REQUEST_REFRAMED, RESPONSE_REFRAMED } from "../../http/forward-headers.js";
import type { CapabilitiesStore } from "../capabilities-store.js";
import type { BearerOf } from "./mcp-renewal.js";

// A signed-in MCP server, reached by the agent through the turn's MCP door (`/mcp/<name>`, turn-mounts.routes.ts) rather
// than at its own address: the agent holds only the turn's bearer, and every request is forwarded whole to the server
// with the connection's access token attached here, renewed when it is about to lapse. A token the server refuses
// anyway is renewed once and the request sent again, so a turn longer than an access token's life never sees it lapse.

export interface RemoteDeps {
    readonly capabilities: Pick<CapabilitiesStore, "get">;
    readonly bearer: BearerOf;
    readonly fetch?: typeof fetch;
}

// What the agent's client sent that is the door's, not the server's: the turn's bearer and anything describing the hop.
const DROPPED = [...REQUEST_REFRAMED, "authorization", "cookie"];

const refusal = (c: Context<AppEnv>, name: string, said: string, status: 401 | 404): Response =>
    c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: `${name}: ${said}` } }, status);

export const createMcpRemoteEndpoint =
    (deps: RemoteDeps) =>
    async (target: { readonly kind: "remote"; readonly capability: string }, c: Context<AppEnv>, call: MountCall): Promise<Response> => {
        const card = await deps.capabilities.get(target.capability);
        if (card?.kind !== "mcp") {
            return refusal(c, call.name, "this connection was removed", 404);
        }
        const first = await deps.bearer(target.capability);
        if ("signIn" in first) {
            return refusal(c, call.name, first.signIn, 401);
        }
        // Held in memory, since a refused request is sent again; a JSON-RPC message is small.
        const body = c.req.method === "GET" || c.req.method === "HEAD" ? null : await c.req.arrayBuffer();
        const send = (bearer: string | undefined): Promise<Response> => {
            const headers = forwardHeaders(c.req.raw.headers, DROPPED);
            if (bearer !== undefined) {
                headers.set("authorization", `Bearer ${bearer}`);
            }
            // Redirects are the client's to follow: following one here would carry the bearer to wherever it points.
            return (deps.fetch ?? fetch)(card.config.url, { method: c.req.method, headers, body, redirect: "manual", signal: call.signal });
        };
        let upstream = await send(first.bearer);
        if (upstream.status === 401) {
            const renewed = await deps.bearer(target.capability, { force: true });
            if ("signIn" in renewed) {
                await upstream.body?.cancel();
                return refusal(c, call.name, renewed.signIn, 401);
            }
            if (renewed.bearer !== first.bearer) {
                await upstream.body?.cancel();
                upstream = await send(renewed.bearer);
            }
        }
        return new Response(upstream.body, { status: upstream.status, headers: forwardHeaders(upstream.headers, RESPONSE_REFRAMED) });
    };
