import { upgradeWebSocket } from "@hono/node-server";
import { errorMessage } from "@intentic/base/errors";
import { MCP_PROTOCOL_VERSION } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { Context, Hono } from "hono";
import type { z } from "zod";
import { bearerFrom, tokenEquals } from "../auth/auth.js";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import { type PeerDoor, peerConnectPath, peerEnrollPath } from "./peer.js";
import type { PeerClient, PeerHub } from "./peer-hub.js";
import type { PeerStore } from "./peer-store.js";

// Every peer door's routes:
// - /system/<slug>/connect: WebSocket, authenticated by the first frame, never the URL
// - /system/<slug>/enroll: redeems the one-time pairing for the durable token
// - /system/<slug>/pair: owner mints a single-use pairing for one id
// - /system/<slug>: roster; DELETE /system/<slug>/:id drops enrollment and the live socket
// - /mcp/<slug>/:id: tunnels JSON-RPC to the peer for MCP-reachable doors
// A per-boot bridge token, never the peer's own enrollment token, gates the MCP pipe; it forwards JSON-RPC unparsed,
// with only a pre-call judgement and a post-call seal as interpretation.

// How long a fresh socket may stay anonymous before the daemon closes it; its only job then is send hello.
const AUTH_DEADLINE_MS = 10_000;

export interface PeerRouteDeps<Client extends PeerClient<Facts, Scopes>, Announced, Facts, Scopes, Extra> {
    readonly store: PeerStore<Extra>;
    readonly hub: PeerHub<Client, Announced, Facts, Scopes>;
    // Every enrolled peer plus what the hub knows now; must distinguish never-connected from connected-but-away.
    readonly summaries: () => Promise<readonly unknown[]>;
    // Per-boot secret the agent's tools carry to the MCP bridge; required exactly when the door has one.
    readonly bridgeToken?: string;
    // Refusal returns as a tool result, not an error, so the model reads it; the peer's own scopes stay the floor.
    readonly beforeCall?: (payload: unknown, c: Context) => Promise<{ readonly refusal: string } | undefined>;
    // What a `tools/call` answer becomes on its way back to the model, by tool name.
    readonly sealAnswer?: (id: string, tool: string, answer: unknown) => unknown;
}

// Grant pushed on connect: the capability's own config, for kinds whose config is the grant. Narrowed by kind before
// the cast, tying the shape to Scopes.
const scopesOf = async <Scopes>(services: Services, kind: "host" | "webext", id: string): Promise<Scopes | undefined> => {
    const capability = (await services.capabilities.list()).find((entry) => entry.id === id && entry.kind === kind);
    return capability === undefined ? undefined : (capability.config as Scopes);
};

interface McpRequest {
    readonly id?: unknown;
    readonly method?: unknown;
    readonly params?: { readonly name?: unknown };
}

// Who may knock and what they carried. A message with no id is a notification, answered 202 per the transport spec; GET
// (the optional server→client stream) is refused honestly since nothing is server-initiated.
const admitMcp = async (
    c: Context,
    bridgeToken: string,
    noun: string,
    store: Pick<PeerStore<unknown>, "enrolled">,
): Promise<Response | { readonly id: string; readonly payload: unknown; readonly request: McpRequest }> => {
    if (!tokenEquals(bearerFrom(c.req.header("authorization")) ?? "", bridgeToken)) {
        return c.json({ error: "unauthorized" }, 401);
    }
    const id = c.req.param("id") ?? "";
    if (!(await store.enrolled(id))) {
        return c.json({ error: `no connected ${noun} named "${id}"` }, 404);
    }
    if (c.req.method === "GET") {
        return c.json({ error: "this endpoint has no server-initiated stream" }, 405);
    }
    if (c.req.method === "DELETE") {
        return c.body(null, 204);
    }
    const payload = (await c.req.json().catch(() => undefined)) as unknown;
    if (payload === undefined) {
        return c.json({ error: "invalid json" }, 400);
    }
    return { id, payload, request: payload as McpRequest };
};

// Handshake and tools/list are answered here when the peer is offline, so a sleeping device doesn't drop out of the
// turn entirely; everything else still reaches the peer, arriving there as an "asleep" error.
const answeredLocally = (
    hub: Pick<PeerHub<never, unknown, unknown, unknown>, "state" | "knownTools">,
    serverName: string,
    id: string,
    request: McpRequest,
): Record<string, unknown> | undefined => {
    if (request.method === "initialize") {
        // Last announced build, or "offline" if never seen; must not claim knowledge it doesn't have.
        const version = (hub.state(id).announced as { version?: string } | undefined)?.version;
        return {
            jsonrpc: "2.0",
            id: request.id,
            result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: serverName, version: version ?? "offline" } },
        };
    }
    if (request.method === "tools/list") {
        return { jsonrpc: "2.0", id: request.id, result: hub.knownTools(id) ?? { tools: [] } };
    }
    return undefined;
};

// Forwards the request; remembers a tools/list answer (what makes offline answers possible) and seals a tools/call
// answer. Errors return as JSON-RPC, not HTTP, so the model reads "asleep" instead of a retry loop.
const forwarded = async (
    hub: Pick<PeerHub<never, unknown, unknown, unknown>, "mcp" | "rememberTools">,
    sealAnswer: ((id: string, tool: string, answer: unknown) => unknown) | undefined,
    id: string,
    payload: unknown,
    request: McpRequest,
): Promise<unknown> => {
    try {
        const answer = await hub.mcp(id, payload);
        if (request.method === "tools/list") {
            hub.rememberTools(id, (answer as { result?: unknown }).result);
            return answer;
        }
        if (request.method === "tools/call" && sealAnswer !== undefined) {
            return sealAnswer(id, typeof request.params?.name === "string" ? request.params.name : "", answer);
        }
        return answer;
    } catch (error) {
        return { jsonrpc: "2.0", id: request.id, error: { code: -32000, message: errorMessage(error) } };
    }
};

export const createPeerRoutes = <
    Hello extends { readonly token: string },
    Client extends PeerClient<Facts, Scopes>,
    Announced,
    Facts,
    Scopes,
    Shape extends z.ZodRawShape,
>(
    services: Services,
    door: PeerDoor<Hello, Announced, Shape>,
    deps: PeerRouteDeps<Client, Announced, Facts, Scopes, z.infer<z.ZodObject<Shape>>>,
) => {
    const { store, hub } = deps;

    // Peer's socket, exempt from the bearer middleware like other upgrades; authorized by the enrollment token in the
    // hello frame, which resolves which peer this is. The daemon never trusts a peer's own identity claim.
    const connect = upgradeWebSocket(() => {
        let detach: (() => void) | undefined;
        let deadline: NodeJS.Timeout | undefined;

        return {
            onOpen: (_event, ws) => {
                deadline = setTimeout(() => {
                    if (detach === undefined) {
                        ws.close(1008, "unauthorized");
                    }
                }, AUTH_DEADLINE_MS);
            },
            // Reads only the hello; once verified, the socket passes to the oRPC link, which rejects a stray second
            // hello.
            onMessage: async (event, ws) => {
                if (detach !== undefined) {
                    return;
                }
                let raw: unknown;
                try {
                    raw = JSON.parse(String(event.data ?? ""));
                } catch {
                    raw = undefined;
                }
                const hello = door.hello.schema.safeParse(raw);
                if (!hello.success) {
                    services.logger.warn({ err: hello.error }, `${door.slug}: first frame was not a hello`);
                    ws.close(1008, "unauthorized");
                    return;
                }
                const id = await store.verify(hello.data.token);
                if (id === undefined) {
                    services.logger.warn(`${door.slug}: rejected an unenrolled token`);
                    ws.close(1008, "unauthorized");
                    return;
                }
                clearTimeout(deadline);
                // `.raw` is the real `ws` socket with the surface oRPC's link needs; WSContext is only a send/close
                // façade.
                const socket = ws.raw as unknown as WebSocket;
                const client = createORPCClient(new RPCLink({ websocket: socket })) as unknown as Client;
                detach = hub.attach(id, { client, close: (code, reason) => ws.close(code, reason), announced: door.hello.announced(hello.data) });

                // Scopes pushed before facts, so a reconnect after the owner tightens a grant enforces it from the
                // first call.
                if (door.scopesKind !== undefined) {
                    const scopes = await scopesOf<Scopes>(services, door.scopesKind, id);
                    if (scopes !== undefined) {
                        await hub.pushScopes(id, scopes);
                    }
                }
                hub.observe(id, await client.describe());
            },
            onClose: () => {
                clearTimeout(deadline);
                detach?.();
            },
            onError: (event) => {
                services.logger.warn({ event: String(event) }, `${door.slug}: socket error`);
            },
        };
    });

    // Agent's door onto a peer: Streamable HTTP MCP in, the peer's answer out. Present only when the door declares a
    // bridge; a runner's contract is typed end-to-end and needs no pipe.
    const mcpSpec = door.mcp;
    const bridgeToken = deps.bridgeToken;
    const mcp =
        mcpSpec === undefined || bridgeToken === undefined
            ? undefined
            : async (c: Context): Promise<Response> => {
                  const admitted = await admitMcp(c, bridgeToken, door.noun, store);
                  if (admitted instanceof Response) {
                      return admitted;
                  }
                  const { id, payload, request } = admitted;
                  const stopped = deps.beforeCall === undefined ? undefined : await deps.beforeCall(payload, c);
                  if (stopped !== undefined) {
                      return c.json({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: stopped.refusal }], isError: true } });
                  }
                  if (request.id === undefined) {
                      // Forwarded and forgotten: a notification expects no answer; skipped when the peer is offline.
                      void hub.mcp(id, payload).catch(() => undefined);
                      return c.body(null, 202);
                  }
                  const local = hub.online(id) ? undefined : answeredLocally(hub, mcpSpec.serverName(id), id, request);
                  return c.json(local ?? (await forwarded(hub, deps.sealAnswer, id, payload, request)));
              };

    return {
        connect,
        mcp,
        // Owner-only; a capability door mints only for an existing card, a runner's pairing names what it becomes.
        pair: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            const id = c.req.query("id") ?? "";
            if (door.scopesKind !== undefined) {
                if ((await scopesOf(services, door.scopesKind, id)) === undefined) {
                    return c.json({ error: `no connected-${door.noun} capability with that id` }, 404);
                }
            } else if (id === "") {
                return c.json({ error: `name the ${door.noun}: /system/${door.slug}/pair?id=<name>` }, 400);
            }
            return c.json(store.mintPairing(id));
        },
        // POST /system/<slug>/enroll: authorized by the pairing alone, exempt from the bearer middleware.
        enroll: async (c: Context<AppEnv>): Promise<Response> => {
            const enrolled = await store.enroll(c.req.header("x-intentic-pair") ?? "");
            if (enrolled === undefined) {
                return c.json({ error: door.expired }, 401);
            }
            return c.json(enrolled);
        },
        /** GET /system/<slug> */
        list: async (c: Context<AppEnv>): Promise<Response> => c.json({ [door.listKey]: await deps.summaries() }),
        // Drops the enrollment and the live socket; the software itself stays until removed at the keyboard.
        revoke: async (c: Context<AppEnv>): Promise<Response> => {
            const denied = await ownerDenied(services, c);
            if (denied !== undefined) {
                return denied;
            }
            const id = c.req.param("id") ?? "";
            hub.disconnect(id, `this ${door.noun}'s access was revoked`);
            return (await store.revoke(id)) ? c.json({ ok: true }) : c.json({ error: `no such ${door.noun}` }, 404);
        },
    };
};

export type PeerRoutes = ReturnType<typeof createPeerRoutes>;

// Mounted before the oRPC catch-all, like the terminal's; one mount ensures a door's socket and enroll route share the
// same slug.
export const mountPeerRoutes = (app: Hono<AppEnv>, door: Pick<PeerDoor<{ token: string }, unknown, z.ZodRawShape>, "slug">, routes: PeerRoutes): void => {
    app.post(`/system/${door.slug}/pair`, routes.pair);
    app.post(peerEnrollPath(door.slug), routes.enroll);
    app.get(`/system/${door.slug}`, routes.list);
    app.delete(`/system/${door.slug}/:id`, routes.revoke);
    app.get(peerConnectPath(door.slug), routes.connect);
    if (routes.mcp !== undefined) {
        app.post(`/mcp/${door.slug}/:id`, routes.mcp);
        app.get(`/mcp/${door.slug}/:id`, routes.mcp);
        app.delete(`/mcp/${door.slug}/:id`, routes.mcp);
    }
};
