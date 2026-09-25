import { upgradeWebSocket } from "@hono/node-server";
import { errorMessage } from "@intentic/base/errors";
import { PEER_TRY_AGAIN, PEER_UNAUTHORIZED } from "@intentic/sandbox-contract/peer-dial";
import { converterReadable, MCP_PROTOCOL_VERSION } from "@intentic/sandbox-contract/peer-mcp-server";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { Context } from "hono";
import type { z } from "zod";
import type { MountCall } from "../agent/tools/turn-mounts.routes.js";
import type { RpcMessage } from "../agent/tools/turn-mounts.js";
import { ownerDenied } from "../auth/owner-gates.js";
import type { Services } from "../composition.js";
import type { AppEnv } from "../app-env.js";
import type { rawRouteServer } from "../http/raw-route-server.js";
import type { PeerDoor } from "./peer.js";
import type { PeerClient, PeerHub } from "./peer-hub.js";
import type { PeerStore } from "./peer-store.js";

// Every peer door's routes:
// - /system/<slug>/connect: WebSocket, authenticated by the first frame, never the URL
// - /system/<slug>/enroll: redeems the one-time pairing for the durable token
// - /system/<slug>/pair: owner mints a single-use pairing for one id
// - /system/<slug>: roster; DELETE /system/<slug>/:id drops enrollment and the live socket
// For an MCP-reachable door, `mcp` is the endpoint the daemon's one MCP door (agent/tools/turn-mounts.routes.ts) hands
// a message to once the turn's lease holds this peer: never the peer's own enrollment token, and the conversation comes
// from the lease. It forwards JSON-RPC unparsed, with only a pre-call judgement and a post-call seal as interpretation.

// How long a fresh socket may stay anonymous before the daemon closes it; its only job then is send hello.
const AUTH_DEADLINE_MS = 10_000;

// Standard WebSocket "protocol error". Here it means one thing: a first frame this build cannot read as a hello.
const PROTOCOL_ERROR = 1002;

// Standard WebSocket "going away", as the hub's heartbeat closes with: a peer that stopped answering, redialled as usual.
const PEER_GONE_QUIET = 1001;

export interface PeerRouteDeps<Client extends PeerClient<Facts, Scopes>, Announced, Facts, Scopes, Extra> {
    readonly store: PeerStore<Extra>;
    readonly hub: PeerHub<Client, Announced, Facts, Scopes>;
    // Every enrolled peer plus what the hub knows now; must distinguish never-connected from connected-but-away.
    readonly summaries: () => Promise<readonly unknown[]>;
    // Refusal returns as a tool result, not an error, so the model reads it; the peer's own scopes stay the floor.
    readonly beforeCall?: (payload: unknown, call: { readonly id: string; readonly conversationId: string | undefined }) => Promise<{ readonly refusal: string } | undefined>;
    // A peer came up and said what it is. Fire-and-forget by contract: the hosts door uses it to put an agent in the
    // rest of that computer, and a connect must not wait on a download.
    readonly onConnected?: (id: string, facts: Facts) => void;
    // What a `tools/call` answer becomes on its way back to the model, by tool name.
    readonly sealAnswer?: (id: string, tool: string, answer: unknown) => unknown;
}

// Grant pushed on connect: the capability's own config, for kinds whose config is the grant. Narrowed by kind before
// the cast, tying the shape to Scopes.
const scopesOf = async <Scopes>(services: Services, kind: "device" | "webext", id: string): Promise<Scopes | undefined> => {
    const capability = (await services.capabilities.list()).find((entry) => entry.id === id && entry.kind === kind);
    return capability === undefined ? undefined : (capability.config as Scopes);
};

// Admitted, or refused with whether the peer should come back. `retry: false` is the expensive answer — it closes the
// socket 1008, which ends the far end's dial loop for good and costs someone a walk to that machine — so it is
// reserved for the one refusal that is genuinely about the credential.
export type PeerAdmission<Scopes> =
    | { readonly id: string; readonly scopes: Scopes | undefined }
    | { readonly refusal: string; readonly retry: boolean };

// Who is at the socket and what still grants them anything: the enrollment says which peer, the card says whether the
// owner is still lending it a machine. Only a store this daemon could READ and that holds no such token is final; a
// card that isn't there is drift, not a decision, and the two are on different sides of the line because the manifest
// is a workspace file (.intentic/config/capabilities.json) while the enrollment is not. Drift is caught by
// peers/invariant.ts and healed by dropping the enrollment, which is what turns it into an honest 1008.
export const admitPeer = async <Scopes>(
    services: Services,
    door: Pick<PeerDoor<{ token: string }, unknown, Record<never, never>>, "noun" | "scopesKind" | "cardOf">,
    store: Pick<PeerStore<unknown>, "verify">,
    token: string,
): Promise<PeerAdmission<Scopes>> => {
    const presented = await store.verify(token);
    if (presented.kind === "unreadable") {
        return { refusal: `this sandbox cannot read its enrollment manifest right now (${presented.detail})`, retry: true };
    }
    if (presented.kind === "unknown") {
        return { refusal: "unauthorized", retry: false };
    }
    const { id } = presented;
    if (door.scopesKind === undefined) {
        return { id, scopes: undefined };
    }
    // The grant is the CARD's, which a connection may be finer than: every environment of one machine is admitted on
    // the one set of switches its owner ticked for that machine.
    const scopes = await scopesOf<Scopes>(services, door.scopesKind, door.cardOf?.(id) ?? id);
    return scopes === undefined
        ? { refusal: `no capability card grants this ${door.noun} anything right now`, retry: true }
        : { id, scopes };
};

// Tells a just-attached peer its grant, then asks what it is. Never rejects: nothing awaits a socket handler's promise,
// and a peer whose socket closes between hello and greeting is ordinary.
export const greetPeer = async <Client extends PeerClient<Facts, Scopes>, Facts, Scopes>(
    services: Pick<Services, "logger">,
    slug: string,
    hub: Pick<PeerHub<Client, unknown, Facts, Scopes>, "pushScopes" | "observe">,
    peer: {
        readonly id: string;
        readonly client: Client;
        readonly scopes: Scopes | undefined;
        readonly hangUp: () => void;
        readonly onConnected: ((id: string, facts: Facts) => void) | undefined;
    },
): Promise<void> => {
    let facts: Facts;
    try {
        // Scopes pushed before facts, so a reconnect after the owner tightens a grant enforces it from the first call;
        // one the hub could not deliver has already cost this socket its place.
        if (peer.scopes !== undefined && !(await hub.pushScopes(peer.id, peer.scopes))) {
            return;
        }
        facts = await peer.client.describe();
    } catch (err) {
        services.logger.warn({ err, id: peer.id }, `${slug}: could not greet a peer that just connected, dropping the connection`);
        peer.hangUp();
        return;
    }
    hub.observe(peer.id, facts);
    peer.onConnected?.(peer.id, facts);
};

// Handshake and tools/list are answered here when the peer is offline, so a sleeping device doesn't drop out of the
// turn entirely; everything else still reaches the peer, arriving there as an "asleep" error.
const answeredLocally = (
    hub: Pick<PeerHub<never, unknown, unknown, unknown>, "state" | "knownTools">,
    serverName: string,
    id: string,
    request: RpcMessage,
): RpcMessage | undefined => {
    if (request.method === "initialize") {
        // Last announced build, or "offline" if never seen; must not claim knowledge it doesn't have.
        const version = (hub.state(id).announced as { version?: string } | undefined)?.version;
        return {
            jsonrpc: "2.0",
            id: request.id ?? null,
            result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: serverName, version: version ?? "offline" } },
        };
    }
    if (request.method === "tools/list") {
        return { jsonrpc: "2.0", id: request.id ?? null, result: hub.knownTools(id) ?? { tools: [] } };
    }
    return undefined;
};

// Forwards the request; remembers a tools/list answer (what makes offline answers possible) and seals a tools/call
// answer. Errors return as JSON-RPC, not HTTP, so the model reads "asleep" instead of a retry loop.
const forwarded = async (
    hub: Pick<PeerHub<never, unknown, unknown, unknown>, "mcp" | "rememberTools">,
    sealAnswer: ((id: string, tool: string, answer: unknown) => unknown) | undefined,
    id: string,
    request: RpcMessage,
): Promise<RpcMessage> => {
    try {
        const answer = (await hub.mcp(id, request)) as RpcMessage;
        if (request.method === "tools/list") {
            // The peer is software on someone else's machine, at whatever build they last installed; what it publishes
            // still has to convert for a local model, where one unconvertible schema fails the whole turn's tool set.
            const listed = (answer as { result?: unknown }).result;
            const result = converterReadable(listed);
            hub.rememberTools(id, result);
            return listed === undefined ? answer : { ...answer, result };
        }
        if (request.method === "tools/call" && sealAnswer !== undefined) {
            return sealAnswer(id, typeof request.params?.["name"] === "string" ? request.params["name"] : "", answer) as RpcMessage;
        }
        return answer;
    } catch (error) {
        return { jsonrpc: "2.0", id: request.id ?? null, error: { code: -32000, message: errorMessage(error) } };
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
                        // A hello that did not arrive says nothing about the enrollment behind it: a laptop waking on a
                        // slow link is exactly the peer this must not unpair.
                        ws.close(PEER_TRY_AGAIN, "no hello within the deadline");
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
                    raw = JSON.parse(String(event.data));
                } catch {
                    raw = undefined;
                }
                const hello = door.hello.schema.safeParse(raw);
                if (!hello.success) {
                    services.logger.warn({ err: hello.error }, `${door.slug}: first frame was not a hello`);
                    // A frame this build cannot read is a protocol fault, named as one. Not 1008: the likeliest cause
                    // is a peer older or newer than this daemon, and version skew must cost a reconnect, not a pairing.
                    ws.close(PROTOCOL_ERROR, "first frame was not a hello");
                    return;
                }
                const admitted = await admitPeer<Scopes>(services, door, store, hello.data.token);
                if ("refusal" in admitted) {
                    services.logger.warn({ reason: admitted.refusal, retry: admitted.retry }, `${door.slug}: refused a socket`);
                    ws.close(admitted.retry ? PEER_TRY_AGAIN : PEER_UNAUTHORIZED, admitted.refusal);
                    return;
                }
                const { id, scopes } = admitted;
                clearTimeout(deadline);
                // `.raw` is the real `ws` socket with the surface oRPC's link needs; WSContext is only a send/close
                // façade.
                const socket = ws.raw as unknown as WebSocket;
                const client = createORPCClient(new RPCLink({ websocket: socket })) as unknown as Client;
                detach = hub.attach(id, { client, close: (code, reason) => ws.close(code, reason), announced: door.hello.announced(hello.data) });
                await greetPeer(services, door.slug, hub, {
                    id,
                    client,
                    scopes,
                    hangUp: () => {
                        ws.close(PEER_GONE_QUIET, "no answer");
                        detach?.();
                    },
                    onConnected: deps.onConnected,
                });
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

    // Agent's way onto a peer: one JSON-RPC message in, the peer's answer out. A door that declares no bridge (a runner's
    // contract is typed end-to-end) answers every message with that, though no turn ever mounts one.
    const mcpSpec = door.mcp;
    const mcp = async (target: { readonly id: string }, message: RpcMessage, call: MountCall): Promise<RpcMessage | undefined> => {
        const { id } = target;
        if (mcpSpec === undefined) {
            return message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `a ${door.noun} has no MCP bridge` } };
        }
        if (!(await store.enrolled(id))) {
            return message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `no connected ${door.noun} named "${id}"` } };
        }
        const stopped = deps.beforeCall === undefined ? undefined : await deps.beforeCall(message, { id, conversationId: call.conversationId });
        if (stopped !== undefined) {
            return { jsonrpc: "2.0", id: message.id ?? null, result: { content: [{ type: "text", text: stopped.refusal }], isError: true } };
        }
        if (message.id === undefined) {
            // Forwarded and forgotten: a notification expects no answer; skipped when the peer is offline.
            void hub.mcp(id, message).catch(() => undefined);
            return undefined;
        }
        return (hub.online(id) ? undefined : answeredLocally(hub, mcpSpec.serverName(id), id, message)) ?? (await forwarded(hub, deps.sealAnswer, id, message));
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
                // Through the card, as admission is: one environment of a machine is a connection of the machine's own
                // card, so re-pairing a distro is the same grant as re-pairing the PC it runs on.
                if ((await scopesOf(services, door.scopesKind, door.cardOf?.(id) ?? id)) === undefined) {
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

// Mounted before the oRPC catch-all, like the terminal's, each under its declaration; one mount ensures a door's socket
// and enroll route share the same slug. The MCP bridge is not among them: it is reached through the daemon's one MCP door.
export const mountPeerRoutes = (
    serve: ReturnType<typeof rawRouteServer>,
    door: Pick<PeerDoor<{ token: string }, unknown, z.ZodRawShape>, "slug">,
    routes: PeerRoutes,
): void => {
    serve(`POST /system/${door.slug}/pair`, routes.pair);
    serve(`POST /system/${door.slug}/enroll`, routes.enroll);
    serve(`GET /system/${door.slug}`, routes.list);
    serve(`DELETE /system/${door.slug}/{id}`, routes.revoke);
    serve(`GET /system/${door.slug}/connect`, routes.connect);
};
