import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import { bearerFrom } from "../../auth/auth.js";
import type { MountTarget, RpcMessage, TurnMounts } from "./turn-mounts.js";

// The one door every daemon-hosted MCP server is reached through, `ALL /mcp/<name>`: the bearer names the conversation,
// its current lease maps the name to a target, and the target's endpoint answers. Streamable HTTP, answered as plain
// JSON: nothing a daemon-hosted server says is server-initiated, so there is no stream to open. An extension endpoint that
// speaks the transport itself (a backend path, a process's port) is the exception, forwarded whole.

// Who a request is for, handed to the endpoint along with the target: the conversation comes from the bearer, never from
// anything the request says about itself.
export interface MountCall {
    readonly name: string;
    readonly conversationId: string | undefined;
    // The HTTP request's own: a client that hung up takes its in-flight call with it.
    readonly signal: AbortSignal;
}

type TargetOf<K extends MountTarget["kind"]> = Extract<MountTarget, { readonly kind: K }>;

// One JSON-RPC message in, its answer out; undefined for a notification, which expects none.
export type RpcEndpoint<T> = (target: T, message: RpcMessage, call: MountCall) => Promise<RpcMessage | undefined>;

export interface MountEndpoints {
    readonly browser: RpcEndpoint<TargetOf<"browser">>;
    readonly device: RpcEndpoint<TargetOf<"device">>;
    readonly webext: RpcEndpoint<TargetOf<"webext">>;
    readonly tools: RpcEndpoint<TargetOf<"tools">>;
    // The whole exchange, forwarded to the backend host or the process (extension-mcp.ts).
    readonly extension: (target: TargetOf<"extension">, c: Context<AppEnv>, call: MountCall) => Promise<Response>;
}

// The endpoint that answers a resolved target's messages, chosen by the target's kind alone.
const rpcOf = (endpoints: MountEndpoints, target: Exclude<MountTarget, TargetOf<"extension">>, call: MountCall) => {
    switch (target.kind) {
        case "browser":
            return (message: RpcMessage) => endpoints.browser(target, message, call);
        case "device":
            return (message: RpcMessage) => endpoints.device(target, message, call);
        case "webext":
            return (message: RpcMessage) => endpoints.webext(target, message, call);
        case "tools":
            return (message: RpcMessage) => endpoints.tools(target, message, call);
    }
};

// The Streamable HTTP edge every JSON-RPC endpoint shares: GET (the optional server-to-client stream) is refused, since
// nothing is server-initiated; DELETE ends the client's session, not the turn, so a resumed client reconnects to the
// same mount; a POST carries one message or a batch, and a notification is answered 202.
const answerRpc = async (c: Context<AppEnv>, handle: (message: RpcMessage) => Promise<RpcMessage | undefined>): Promise<Response> => {
    if (c.req.method === "GET") {
        return c.json({ error: "this endpoint has no server-initiated stream" }, 405);
    }
    if (c.req.method === "DELETE") {
        return c.body(null, 204);
    }
    if (c.req.method !== "POST") {
        return c.json({ error: `${c.req.method} is not part of the MCP transport` }, 405);
    }
    // allow(silent-catch): a body that is not JSON is answered as the JSON-RPC parse error just below
    const payload = (await c.req.json().catch(() => undefined)) as RpcMessage | RpcMessage[] | null | undefined;
    if (payload === undefined || payload === null || typeof payload !== "object") {
        return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid json" } }, 400);
    }
    if (Array.isArray(payload)) {
        const answers = (await Promise.all(payload.map((message) => handle(message)))).filter((answer): answer is RpcMessage => answer !== undefined);
        return answers.length === 0 ? c.body(null, 202) : c.json(answers);
    }
    const answer = await handle(payload);
    return answer === undefined ? c.body(null, 202) : c.json(answer);
};

export const createTurnMountRoute =
    (mounts: Pick<TurnMounts, "resolve">, endpoints: MountEndpoints) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const name = c.req.param("mount") ?? "";
        const reach = mounts.resolve(bearerFrom(c.req.header("authorization")), name);
        if ("refused" in reach) {
            return reach.refused === "unknown"
                ? c.json({ error: "unauthorized" }, 401)
                : // Whatever the path names, a bearer reaches only what its own turn mounted, and nothing once it ends.
                  c.json({ error: `"${name}" is not a server this turn mounted` }, 403);
        }
        const call: MountCall = { name, conversationId: reach.conversationId, signal: c.req.raw.signal };
        const { target } = reach;
        if (target.kind === "extension") {
            return endpoints.extension(target, c, call);
        }
        return answerRpc(c, rpcOf(endpoints, target, call));
    };
