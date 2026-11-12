import { z } from "zod";
import type { ToolOutput } from "../../guard/mcp-output.js";
import type { Context } from "hono";
import type { AppEnv } from "../../app-env.js";
import { bearerFrom } from "../../auth/auth.js";
import { opt } from "../../opt.js";
import type { MountTarget, RpcMessage, TurnHold, TurnMounts } from "./turn-mounts.js";

// The one door every daemon-hosted MCP server is reached through, `ALL /mcp/<name>`: the bearer names one live turn (and
// its conversation), that turn's lease maps the name to a target, and the target's endpoint answers. Streamable HTTP, answered as plain
// JSON: nothing a daemon-hosted server says is server-initiated, so there is no stream to open. An extension endpoint that
// speaks the transport itself (a backend path, a process's port) and a signed-in remote server are the exceptions,
// forwarded whole.

// Who a request is for, handed to the endpoint along with the target: the conversation comes from the bearer, never from
// anything the request says about itself.
export interface MountCall {
    readonly name: string;
    readonly conversationId: string | undefined;
    // The HTTP request's own: a client that hung up takes its in-flight call with it.
    readonly signal: AbortSignal;
    // The longest the turn's MCP client waits on one call, when its runtime cannot be told longer (LeaseOptions).
    readonly clientCeilingMs?: number;
}

type TargetOf<K extends MountTarget["kind"]> = Extract<MountTarget, { readonly kind: K }>;

// One JSON-RPC message in, its answer out; undefined for a notification, which expects none.
export type RpcEndpoint<T> = (target: T, message: RpcMessage, call: MountCall) => Promise<RpcMessage | undefined>;

export interface MountEndpoints {
    readonly browser: RpcEndpoint<TargetOf<"browser">>;
    readonly daemon: RpcEndpoint<TargetOf<"daemon">>;
    readonly device: RpcEndpoint<TargetOf<"device">>;
    readonly webext: RpcEndpoint<TargetOf<"webext">>;
    readonly phone: RpcEndpoint<TargetOf<"phone">>;
    readonly tools: RpcEndpoint<TargetOf<"tools">>;
    // The whole exchange, forwarded to the backend host or the process (extension-mcp.ts).
    readonly extension: (target: TargetOf<"extension">, c: Context<AppEnv>, call: MountCall) => Promise<Response>;
    // The whole exchange, forwarded to a signed-in MCP server with its fresh bearer (capabilities/mcp-oauth/mcp-remote.ts).
    readonly remote: (target: TargetOf<"remote">, c: Context<AppEnv>, call: MountCall) => Promise<Response>;
}

// A daemon tool server answers in this process, with the request's own signal: nothing to reach but the object itself.
export const daemonEndpoint: RpcEndpoint<TargetOf<"daemon">> = (target, message, call) => target.server.handle(message, call.signal);

// The endpoint that answers a resolved target's messages, chosen by the target's kind alone.
const rpcOf = (endpoints: MountEndpoints, target: Exclude<MountTarget, TargetOf<"extension" | "remote">>, call: MountCall) => {
    switch (target.kind) {
        case "browser":
            return (message: RpcMessage) => endpoints.browser(target, message, call);
        case "daemon":
            return (message: RpcMessage) => endpoints.daemon(target, message, call);
        case "device":
            return (message: RpcMessage) => endpoints.device(target, message, call);
        case "webext":
            return (message: RpcMessage) => endpoints.webext(target, message, call);
        case "phone":
            return (message: RpcMessage) => endpoints.phone(target, message, call);
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

const ToolCallSchema = z.object({ name: z.string() });

// A forwarded tools/call holds the turn's watchdog while it runs: the turn is waiting on the daemon and what it reaches
// (a device's command, a browser's nine-minute wait_for), not on its vendor, and a loop's 120 s silence limit
// (runtimes/decorators/turn-watchdog.ts) ended such turns mid-call. The turn's hard cap still bounds them. A daemon server
// holds its own (daemon-servers.ts heldDoor).
const held =
    (handle: (message: RpcMessage) => Promise<RpcMessage | undefined>, hold: TurnHold | undefined) =>
    async (message: RpcMessage): Promise<RpcMessage | undefined> => {
        if (hold === undefined || message.method !== "tools/call") {
            return await handle(message);
        }
        const release = hold();
        try {
            return await handle(message);
        } finally {
            release();
        }
    };

export const createTurnMountRoute =
    (
        mounts: Pick<TurnMounts, "resolve">,
        endpoints: MountEndpoints,
        clean?: (tool: string, result: ToolOutput, conversationId: string | undefined) => Promise<ToolOutput>,
        // Every stored secret's value masked to its reference in what a tool answered, for every target and every
        // runtime: the one place every mounted call's result passes. Claude's PostToolUse hook also masks; masking twice
        // finds nothing the second time. Until 2026-10-25 only Claude, Pi and Cursor masked, so a script the code server
        // ran printed a resolved secret straight to a Codex, OpenCode, ACP or Muse model.
        mask?: (result: ToolOutput) => Promise<ToolOutput>,
    ) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const name = c.req.param("mount") ?? "";
        const reach = mounts.resolve(bearerFrom(c.req.header("authorization")), name);
        if ("refused" in reach) {
            return reach.refused === "unknown"
                ? c.json({ error: "unauthorized" }, 401)
                : // Whatever the path names, a bearer reaches only what its own turn mounted, and nothing once it ends.
                  c.json({ error: `"${name}" is not a server this turn mounted` }, 403);
        }
        const call: MountCall = { name, conversationId: reach.conversationId, signal: c.req.raw.signal, ...opt("clientCeilingMs", reach.clientCeilingMs) };
        const { target } = reach;
        if (target.kind === "extension") {
            return endpoints.extension(target, c, call);
        }
        if (target.kind === "remote") {
            return endpoints.remote(target, c, call);
        }
        const handle = held(rpcOf(endpoints, target, call), target.kind === "daemon" ? undefined : reach.hold);
        return answerRpc(c, async (message) => {
            const answered = await handle(message);
            // Transport messages and notifications are untouched.
            const toolCall = message.method === "tools/call" ? ToolCallSchema.safeParse(message.params) : undefined;
            if (toolCall?.success !== true || answered?.result === undefined) {
                return answered;
            }
            const masked = mask === undefined ? answered.result : await mask(answered.result);
            const answer = masked === answered.result ? answered : { ...answered, result: masked };
            // Daemon servers already pass through sealedDoor's cleaning.
            if (reach.cleanOutput === false || target.kind === "daemon" || clean === undefined) {
                return answer;
            }
            const result = await clean(`mcp__${name}__${toolCall.data.name}`, masked, call.conversationId);
            return result === masked ? answer : { ...answer, result };
        });
    };
