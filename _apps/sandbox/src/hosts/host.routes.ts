import { upgradeWebSocket } from "@hono/node-server";
import { type Capability, HostClientFrameSchema, type HostSummary, MCP_PROTOCOL_VERSION } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import type { Services } from "../composition.js";
import { bearerFrom, tokenEquals } from "../auth/auth.js";
import type { HostConnection } from "./host-hub.js";

/* The three surfaces of a connected computer:
 *
 *   /system/hosts/connect  the machine's own WebSocket (authenticated by its first frame — see host-protocol).
 *   /mcp/hosts/:id         the loopback MCP endpoint the AGENT's tools point at, which tunnels JSON-RPC to it.
 *   /system/hosts          the owner's view: which machines are enrolled, and which are up right now.
 *
 * The middle one is where the security shape of this feature is decided. The agent reaches a machine through a
 * URL on this daemon, authenticated by a PER-BOOT bridge token that exists only inside the container — it never
 * holds the machine's own enrollment token. So the worst a prompt-injected agent can exfiltrate is a handle that
 * dies with the daemon and only works from inside it, and the grant it can exercise through that handle is the
 * one the owner ticked, enforced on the machine itself. */

// How long a freshly-opened socket may stay anonymous before the daemon gives up on it. It has exactly one job
// in that window: send the hello frame it already has in hand.
const AUTH_DEADLINE_MS = 10_000;

// The route the machine's agent dials. Exempt from the bearer middleware (app.ts) like the other upgrades, but
// authorized differently: no browser is involved, so there is no ticket to redeem — the enrollment token arrives
// in the hello frame and resolves WHICH machine this is. The daemon never trusts a machine's claim about its own
// identity; the token was minted against one capability id and that is the id the socket gets.
export const createHostConnectRoute = (services: Services) =>
    upgradeWebSocket(() => {
        let id: string | undefined;
        let connection: HostConnection | undefined;
        let deadline: NodeJS.Timeout | undefined;

        return {
            onOpen: (_event, ws) => {
                connection = {
                    send: (frame) => ws.send(JSON.stringify(frame)),
                    close: (code, reason) => ws.close(code, reason),
                };
                deadline = setTimeout(() => {
                    if (id === undefined) {
                        ws.close(1008, "unauthorized");
                    }
                }, AUTH_DEADLINE_MS);
            },
            onMessage: async (event, ws) => {
                const frame = HostClientFrameSchema.safeParse(JSON.parse(String(event.data ?? "")));
                if (!frame.success) {
                    services.logger.warn({ err: frame.error }, "host: unparseable frame");
                    return;
                }
                if (frame.data.type === "hello") {
                    // Re-hello on a live socket is how a machine reports a version change after a self-upgrade;
                    // it re-verifies, because the token is the only thing that decides identity here.
                    const enrolled = await services.hosts.verify(frame.data.token);
                    if (enrolled === undefined) {
                        services.logger.warn("host: rejected an unenrolled token");
                        ws.close(1008, "unauthorized");
                        return;
                    }
                    clearTimeout(deadline);
                    if (id === undefined && connection !== undefined) {
                        id = enrolled;
                        services.hostHub.attach(enrolled, connection);
                    }
                    services.hostHub.hello(enrolled, frame.data.version, frame.data.facts);
                    // The grant, immediately: the machine refuses everything until it knows what it may do, so a
                    // reconnect after the owner tightened a scope enforces the NEW one from its first call.
                    const capability = (await services.capabilities.list()).find((entry) => entry.id === enrolled && entry.kind === "host");
                    if (capability?.kind === "host") {
                        services.hostHub.pushScopes(enrolled, capability.config);
                    }
                    return;
                }
                if (id === undefined) {
                    ws.close(1008, "unauthorized");
                    return;
                }
                if (frame.data.type === "rpc") {
                    services.hostHub.deliver(id, frame.data.payload);
                    return;
                }
                if (frame.data.type === "ping") {
                    ws.send(JSON.stringify({ type: "pong" }));
                }
            },
            onClose: () => {
                clearTimeout(deadline);
                if (id !== undefined && connection !== undefined) {
                    services.hostHub.detach(id, connection);
                }
            },
            onError: (event) => {
                services.logger.warn({ event: String(event) }, "host: socket error");
            },
        };
    });

/* The agent's door onto a machine: Streamable HTTP MCP in, the machine's own answer out.
 *
 * Deliberately not an MCP server — a PIPE. The daemon parses no tool schema and validates no argument: it
 * forwards the JSON-RPC message and returns what came back, so `tools/list` is whatever that machine's binary
 * knows how to do today. That is what keeps a machine's capabilities on the machine's release cycle instead of
 * this daemon's, and it is why a new tool on a laptop needs no sandbox rebuild.
 *
 * A message with no id is a notification (`notifications/initialized`): nothing to wait for, so it is delivered
 * and answered 202, per the transport spec. GET is the optional server→client SSE stream; we have no server-
 * initiated messages, so it is honestly refused rather than left hanging. */
export const createHostMcpRoute =
    (services: Services) =>
    async (c: Context): Promise<Response> => {
        if (!tokenEquals(bearerFrom(c.req.header("authorization")) ?? "", services.hostBridgeToken)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const id = c.req.param("id") ?? "";
        if (!(await services.hosts.enrolled(id))) {
            return c.json({ error: `no connected computer named "${id}"` }, 404);
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
        const request = payload as { id?: unknown; method?: unknown };
        if (request.id === undefined) {
            services.hostHub.notify(id, payload);
            return c.body(null, 202);
        }
        /* A turn loads its MCP servers before it does anything, and half the time a personal computer is asleep
         * at that moment. Forwarding the handshake to a machine that cannot answer would fail the connection and
         * take the whole machine out of the turn — the agent would not even know it exists. So the two questions
         * that are ABOUT the connection rather than about the computer are answered here when it is offline: the
         * handshake, and the tool list as the machine last reported it. Everything else still goes to the machine,
         * where a call arrives as a plain "this computer is asleep" the model can read and pass on. */
        if (!services.hostHub.online(id)) {
            if (request.method === "initialize") {
                return c.json({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        protocolVersion: MCP_PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: { name: `intentic-host:${id}`, version: services.hostHub.state(id).version ?? "offline" },
                    },
                });
            }
            if (request.method === "tools/list") {
                return c.json({ jsonrpc: "2.0", id: request.id, result: services.hostHub.knownTools(id) ?? { tools: [] } });
            }
        }
        try {
            const answer = await services.hostHub.call(id, payload);
            if (request.method === "tools/list") {
                services.hostHub.rememberTools(id, (answer as { result?: unknown }).result);
            }
            return c.json(answer);
        } catch (error) {
            /* An offline machine is a normal state, not a fault: laptops sleep. Answering as a JSON-RPC ERROR
             * rather than an HTTP one is what makes that legible to the model — it reads "this computer is
             * asleep" as a tool result and can say so, where a 503 surfaces as an MCP transport failure that
             * looks like a broken sandbox and invites a retry loop. */
            return c.json({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
            });
        }
    };

// The owner's view of their machines: the manifest's host capabilities, each with whatever the hub knows about
// it right now. Enrollment state is deliberately part of it — "added but never connected" is the state the
// connect card exists to resolve, and it must be distinguishable from "connected but asleep".
export const hostSummaries = async (services: Services): Promise<HostSummary[]> => {
    const capabilities = await services.capabilities.list();
    return capabilities
        .filter((capability): capability is Extract<Capability, { kind: "host" }> => capability.kind === "host")
        .map((capability) => Object.assign({ id: capability.id, platform: capability.config.platform }, services.hostHub.state(capability.id)));
};
