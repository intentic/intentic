import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import type { MountCall } from "../../agent/tools/turn-mounts.routes.js";
import { readBoundedBytes } from "../../http/bounded-body.js";
import { forwardHeaders, REQUEST_REFRAMED, RESPONSE_REFRAMED } from "../../http/forward-headers.js";
import type { CapabilitiesStore } from "../capabilities-store.js";
import { createOpenCalls, credentialPrint, type OpenCall, type OpenCalls } from "../credentials/open-calls.js";
import type { BearerOf } from "./mcp-renewal.js";
import { mcpSessionOf } from "./mcp-session.js";

// A signed-in MCP server, reached by the agent through the turn's MCP door (`/mcp/<name>`, turn-mounts.routes.ts) rather
// than at its own address: the agent holds only the turn's bearer, and every request is forwarded whole to the server
// with the connection's access token attached here, renewed when it is about to lapse. A token the server refuses
// anyway is renewed once and the request sent again, so a turn longer than an access token's life never sees it lapse.
// The door carries a bounded number of calls at once (open-calls.ts: a GET's event stream in its own pool), holds a
// request body to MCP_BODY_MAX, and cuts an open call or stream once its connection is removed, signed in again as
// someone else or pasted over, or the conversation's reach no longer covers it.

export interface RemoteDeps {
    readonly capabilities: Pick<CapabilitiesStore, "get">;
    readonly bearer: BearerOf;
    readonly fetch?: typeof fetch;
    // Whether the conversation may still spend this capability (credential-reach.ts); absent, nobody is limited.
    readonly reaches?: (conversationId: string | undefined, capability: string) => Promise<boolean>;
    readonly openCalls?: OpenCalls;
}

// A JSON-RPC message or batch, held whole since a refused one is sent again; far past any real one.
export const MCP_BODY_MAX = 8 * 1024 * 1024;

// Which connection a call speaks as: the server's address and who signed in, not the access token itself, which a
// renewal replaces without the credential changing hands.
const printOf = (config: { readonly url: string; readonly token?: string | undefined }): string => {
    const session = mcpSessionOf(config.token);
    return session === undefined
        ? credentialPrint([config.url, config.token?.trim()])
        : credentialPrint([config.url, session.issuer, session.clientId, session.account, session.resource]);
};

// Why an open call may no longer run, or undefined while it may.
const staleness =
    (deps: RemoteDeps) =>
    async (call: OpenCall): Promise<string | undefined> => {
        const card = await deps.capabilities.get(call.subject);
        if (card?.kind !== "mcp") {
            return "this connection was removed";
        }
        if (printOf(card.config) !== call.print) {
            return "this connection was signed in again or given another token";
        }
        if (deps.reaches !== undefined && !(await deps.reaches(call.conversationId, call.subject))) {
            return "this conversation may no longer use this connection";
        }
        return undefined;
    };

// What the agent's client sent that is the door's, not the server's: the turn's bearer and anything describing the hop.
const DROPPED = [...REQUEST_REFRAMED, "authorization", "cookie"];

const refusal = (c: Context<AppEnv>, name: string, said: string, status: 401 | 403 | 404 | 413 | 429): Response =>
    c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: `${name}: ${said}` } }, status);

type RemoteTarget = { readonly kind: "remote"; readonly capability: string };

export const createMcpRemoteEndpoint = (deps: RemoteDeps) => {
    const openCalls = deps.openCalls ?? createOpenCalls();
    const stale = staleness(deps);
    openCalls.watch(stale);
    return async (target: RemoteTarget, c: Context<AppEnv>, call: MountCall): Promise<Response> => {
        const card = await deps.capabilities.get(target.capability);
        if (card?.kind !== "mcp") {
            return refusal(c, call.name, "this connection was removed", 404);
        }
        const opening: OpenCall = {
            subject: target.capability,
            conversationId: call.conversationId,
            pool: c.req.method === "GET" ? "stream" : "call",
            print: printOf(card.config),
        };
        const admitted = openCalls.admit(opening, call.signal);
        if (admitted === undefined) {
            const what = opening.pool === "stream" ? "event streams" : "calls";
            return refusal(c, call.name, `too many ${what} to this sandbox's MCP servers are open at once; wait for one to finish`, 429);
        }
        try {
            const answer = await forward(deps, target, card.config.url, c, { ...call, signal: admitted.signal }, stale, opening);
            return admitted.hold(answer);
        } catch (error) {
            admitted.release();
            throw error;
        }
    };
};

const forward = async (
    deps: RemoteDeps,
    target: RemoteTarget,
    url: string,
    c: Context<AppEnv>,
    call: MountCall,
    stale: (call: OpenCall) => Promise<string | undefined>,
    opening: OpenCall,
): Promise<Response> => {
    const out = await stale(opening);
    if (out !== undefined) {
        return refusal(c, call.name, out, 403);
    }
    const first = await deps.bearer(target.capability);
    if ("signIn" in first) {
        return refusal(c, call.name, first.signIn, 401);
    }
    // Held in memory, since a refused request is sent again; a JSON-RPC message is small, and one past the cap is
    // refused before more of it is read.
    let body: Uint8Array<ArrayBuffer> | null = null;
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
        const read = await readBoundedBytes(c.req.raw, MCP_BODY_MAX);
        if (read.kind !== "ok") {
            return refusal(c, call.name, `a request body is at most ${String(MCP_BODY_MAX / 1024 / 1024)} MiB`, 413);
        }
        body = new Uint8Array(read.value);
    }
    const send = (bearer: string | undefined): Promise<Response> => {
        const headers = forwardHeaders(c.req.raw.headers, DROPPED);
        if (bearer !== undefined) {
            headers.set("authorization", `Bearer ${bearer}`);
        }
        // Redirects are the client's to follow: following one here would carry the bearer to wherever it points.
        return (deps.fetch ?? fetch)(url, { method: c.req.method, headers, body, redirect: "manual", signal: call.signal });
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
