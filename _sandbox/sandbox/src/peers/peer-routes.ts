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

/* THE ROUTES EVERY PEER DOOR HAS, written once:
 *
 *   /system/<slug>/connect   the peer's own WebSocket, authenticated by its first frame (never the URL, which
 *                            would put a durable key into every proxy log between a laptop and the sandbox).
 *   /system/<slug>/enroll    redeems the one-time pairing for the durable token, authorized by the pairing alone.
 *   /system/<slug>/pair      the owner mints a single-use pairing bound to ONE id, so a redeemed token can only
 *                            ever become the peer they were looking at when they clicked Connect.
 *   /system/<slug>           the roster; DELETE /system/<slug>/:id revokes: the enrollment goes and the live
 *                            socket with it.
 *   /mcp/<slug>/:id          for the doors the agent reaches through MCP: the loopback endpoint its tools point
 *                            at, which tunnels JSON-RPC to the peer over the socket the peer itself opened.
 *
 * The MCP bridge is where the security shape is decided. The agent reaches a peer through a URL on this daemon,
 * authenticated by a PER-BOOT bridge token that exists only inside the container: it never holds the peer's own
 * enrollment token. So the worst a prompt-injected agent can exfiltrate is a handle that dies with the daemon
 * and only works from inside it, and the grant it can exercise through that handle is the one the owner ticked,
 * enforced on the peer itself.
 *
 * Deliberately not an MCP server, a PIPE. The daemon parses no tool schema and validates no argument: it
 * forwards the JSON-RPC message and returns what came back, so `tools/list` is whatever that peer's build knows
 * how to do today, and a new tool on a laptop or in a store release needs no sandbox rebuild. The two hooks a
 * door may add are the only interpretation: a judgement BEFORE a call leaves (a command headed for somebody's
 * own device), and a seal on what comes BACK (page text is a stranger's writing). */

// How long a freshly-opened socket may stay anonymous before the daemon gives up on it. It has exactly one job
// in that window: send the hello frame it already has in hand.
const AUTH_DEADLINE_MS = 10_000;

export interface PeerRouteDeps<Client extends PeerClient<Facts, Scopes>, Announced, Facts, Scopes, Extra> {
    readonly store: PeerStore<Extra>;
    readonly hub: PeerHub<Client, Announced, Facts, Scopes>;
    // The owner's view: every enrolled peer, with whatever the hub knows about it right now. "Enrolled but
    // never connected" must be distinguishable from "connected but away", which is why it is the door's own.
    readonly summaries: () => Promise<readonly unknown[]>;
    // The per-boot secret the agent's tools carry to the MCP bridge. Required exactly when the door has one.
    readonly bridgeToken?: string;
    /* THE OWNER'S POLICY, BEFORE THE TUNNEL: the last thing that sees a `tools/call` while a person can still
     * be asked about it. A refusal travels back as an ordinary tool RESULT rather than a JSON-RPC error, so
     * the model reads the sentence and tells the owner what happened, where a transport failure reads as a
     * broken sandbox and invites a retry. The peer's own scopes remain the floor underneath. */
    readonly beforeCall?: (payload: unknown, c: Context) => Promise<{ readonly refusal: string } | undefined>;
    // What a `tools/call` answer becomes on its way back to the model, by tool name.
    readonly sealAnswer?: (id: string, tool: string, answer: unknown) => unknown;
}

// The grant pushed down on connect: the capability's own config, for the kinds whose config IS the grant.
// Narrowed by kind before the cast, which is what ties the config's shape to the door's Scopes.
const scopesOf = async <Scopes>(services: Services, kind: "host" | "webext", id: string): Promise<Scopes | undefined> => {
    const capability = (await services.capabilities.list()).find((entry) => entry.id === id && entry.kind === kind);
    return capability === undefined ? undefined : (capability.config as Scopes);
};

interface McpRequest {
    readonly id?: unknown;
    readonly method?: unknown;
    readonly params?: { readonly name?: unknown };
}

/* Who may knock, and what they carried. A message with no id is a notification (`notifications/initialized`):
 * nothing to wait for, so it is delivered and answered 202, per the transport spec. GET is the optional
 * server→client SSE stream; there are no server-initiated messages, so it is honestly refused rather than left
 * hanging. */
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

/* A turn loads its MCP servers before it does anything, and half the time a personal device is asleep or a
 * browser shut at that moment. Forwarding the handshake to a peer that cannot answer would fail the connection
 * and take the whole peer out of the turn: the agent would not even know it exists. So the two questions that
 * are ABOUT the connection rather than about the peer are answered here when it is offline: the handshake,
 * and the tool list as last reported. Everything else still goes to the peer, where a call arrives as a plain
 * "this device is asleep" the model can read and pass on. */
const answeredLocally = (
    hub: Pick<PeerHub<never, unknown, unknown, unknown>, "state" | "knownTools">,
    serverName: string,
    id: string,
    request: McpRequest,
): Record<string, unknown> | undefined => {
    if (request.method === "initialize") {
        // The build the peer last announced, or "offline" for one that never has: an answer invented here must
        // not claim to know what it does not.
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

/* Forward one request and hand back what the peer said, minus the two things the bridge does to it: the tool
 * list is remembered (which is what makes the offline answer possible), and a call's answer goes through the
 * door's seal where it has one.
 *
 * An offline peer is a normal state, not a fault: laptops sleep, browsers close. Answering as a JSON-RPC ERROR
 * rather than an HTTP one is what makes that legible to the model: it reads "this device is asleep" as a tool
 * result and can say so, where a 503 surfaces as an MCP transport failure that looks like a broken sandbox and
 * invites a retry loop. */
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

    // The peer's socket. Exempt from the bearer middleware (app.ts) like the other upgrades, but authorized
    // differently: no browser is involved, so there is no ticket to redeem; the enrollment token arrives in the
    // hello frame and resolves WHICH peer this is. The daemon never trusts a peer's claim about its own identity;
    // the token was minted against one id and that is the id the socket gets.
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
            /* The ONLY message this handler ever reads is the hello. Once the token checks out, the socket is
             * handed to an oRPC link and every later message belongs to it, so a second hello (a peer that
             * reconnected without the close arriving, say) is not a re-auth but a stray frame the link rejects
             * on its own. */
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
                /* node-server hands the real socket on `.raw`, an `ws` WebSocket, which carries the
                 * addEventListener/send/readyState surface oRPC's link needs. WSContext itself does not, since
                 * it is a send/close façade for handler code. */
                const socket = ws.raw as unknown as WebSocket;
                const client = createORPCClient(new RPCLink({ websocket: socket })) as unknown as Client;
                detach = hub.attach(id, { client, close: (code, reason) => ws.close(code, reason), announced: door.hello.announced(hello.data) });

                /* Scopes first, then facts, in that order for a reason: the peer refuses everything until it
                 * knows its grant, so pushing before asking is what makes a reconnect after the owner tightened
                 * a switch enforce the NEW one from its first call. */
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

    /* The agent's door onto a peer: Streamable HTTP MCP in, the peer's own answer out. Present exactly when the
     * door declares a bridge; a runner's contract is typed end to end and has no pipe. */
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
                      // A notification expects no answer, so it is forwarded and forgotten, but only to a peer
                      // that is actually there; an offline one has nothing to tell.
                      void hub.mcp(id, payload).catch(() => undefined);
                      return c.body(null, 202);
                  }
                  const local = hub.online(id) ? undefined : answeredLocally(hub, mcpSpec.serverName(id), id, request);
                  return c.json(local ?? (await forwarded(hub, deps.sealAnswer, id, payload, request)));
              };

    return {
        connect,
        mcp,
        /* POST /system/<slug>/pair. Owner-only: giving a member hands on the owner's laptop or browser is not a
         * collaboration feature. A capability-backed door mints only for a card that exists; a runner's pairing
         * names the runner it will become. */
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
        // POST /system/<slug>/enroll. Redeemed by the peer, authorized by the pairing alone (exempt from the bearer
        // middleware), so nobody signs into Google on the thing being connected.
        enroll: async (c: Context<AppEnv>): Promise<Response> => {
            const enrolled = await store.enroll(c.req.header("x-intentic-pair") ?? "");
            if (enrolled === undefined) {
                return c.json({ error: door.expired }, 401);
            }
            return c.json(enrolled);
        },
        /** GET /system/<slug> */
        list: async (c: Context<AppEnv>): Promise<Response> => c.json({ [door.listKey]: await deps.summaries() }),
        // DELETE /system/<slug>/:id. Revoke: the enrollment goes, and the live socket with it. What stays is the
        // software installed over there, which only the person at that keyboard can remove; with its enrollment
        // gone it can no longer reach this sandbox at all.
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

// Every door's routes sit before the oRPC catch-all, like the terminal's, and under the one slug the far end
// dials: one mount so a door cannot serve its socket on a path its enroll route does not match.
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
