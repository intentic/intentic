import { upgradeWebSocket } from "@hono/node-server";
import { errorMessage } from "@intentic/base/errors";
import { type Capability, HostHelloSchema, type HostSummary, MCP_PROTOCOL_VERSION } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { Context } from "hono";
import type { Services } from "../composition.js";
import { bearerFrom, tokenEquals } from "../auth/auth.js";
import { commandInCall, judgeHostCommand } from "./host-command-gate.js";
import type { HostClient } from "./host-hub.js";

/* The three surfaces of a connected device:
 *
 *   /system/hosts/connect  the machine's own WebSocket (authenticated by its first frame, see host-protocol).
 *   /mcp/hosts/:id         the loopback MCP endpoint the AGENT's tools point at, which tunnels JSON-RPC to it.
 *   /system/hosts          the owner's view: which machines are enrolled, and which are up right now.
 *
 * The middle one is where the security shape of this feature is decided. The agent reaches a machine through a
 * URL on this daemon, authenticated by a PER-BOOT bridge token that exists only inside the container, it never
 * holds the machine's own enrollment token. So the worst a prompt-injected agent can exfiltrate is a handle that
 * dies with the daemon and only works from inside it, and the grant it can exercise through that handle is the
 * one the owner ticked, enforced on the machine itself. */

// How long a freshly-opened socket may stay anonymous before the daemon gives up on it. It has exactly one job
// in that window: send the hello frame it already has in hand.
const AUTH_DEADLINE_MS = 10_000;

// The route the machine's agent dials. Exempt from the bearer middleware (app.ts) like the other upgrades, but
// authorized differently: no browser is involved, so there is no ticket to redeem, the enrollment token arrives
// in the hello frame and resolves WHICH machine this is. The daemon never trusts a machine's claim about its own
// identity; the token was minted against one capability id and that is the id the socket gets.
export const createHostConnectRoute = (services: Services) =>
    upgradeWebSocket(() => {
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
             * handed to an oRPC link and every later message belongs to it, so a second hello (a machine that
             * reconnected without the close arriving, say) is not a re-auth but a stray frame the link will
             * reject on its own. */
            onMessage: async (event, ws) => {
                if (detach !== undefined) {
                    return;
                }
                const hello = HostHelloSchema.safeParse(JSON.parse(String(event.data ?? "")));
                if (!hello.success) {
                    services.logger.warn({ err: hello.error }, "host: first frame was not a hello");
                    ws.close(1008, "unauthorized");
                    return;
                }
                const id = await services.hosts.verify(hello.data.token);
                if (id === undefined) {
                    services.logger.warn("host: rejected an unenrolled token");
                    ws.close(1008, "unauthorized");
                    return;
                }
                clearTimeout(deadline);
                /* node-server hands the real socket on `.raw`, an `ws` WebSocket, which carries the
                 * addEventListener/send/readyState surface oRPC's link needs. WSContext itself does not, since it
                 * is a send/close façade for handler code. */
                const socket = ws.raw as unknown as WebSocket;
                const client: HostClient = createORPCClient(new RPCLink({ websocket: socket }));
                detach = services.hostHub.attach(id, { client, close: (code, reason) => ws.close(code, reason) });
                services.hostHub.announce(id, hello.data.version);

                /* Two calls the moment the link is live, in this order for a reason: the machine refuses
                 * everything until it knows its grant, so pushing scopes before asking anything is what makes a
                 * reconnect after the owner tightened a switch enforce the NEW one from its first call. */
                const capability = (await services.capabilities.list()).find((entry) => entry.id === id && entry.kind === "host");
                if (capability?.kind === "host") {
                    await services.hostHub.pushScopes(id, capability.config);
                }
                services.hostHub.observe(id, await client.describe());
            },
            onClose: () => {
                clearTimeout(deadline);
                detach?.();
            },
            onError: (event) => {
                services.logger.warn({ event: String(event) }, "host: socket error");
            },
        };
    });

/* The agent's door onto a machine: Streamable HTTP MCP in, the machine's own answer out.
 *
 * Deliberately not an MCP server, a PIPE. The daemon parses no tool schema and validates no argument: it
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
            return c.json({ error: `no connected device named "${id}"` }, 404);
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
        /* THE OWNER'S SAFETY POLICY, BEFORE THE TUNNEL. This route is the last thing that sees a call while a
         * person can still be asked about it, so a `run_command` headed for somebody's own device is judged
         * here (hosts/host-command-gate.ts argues the whole shape). The scopes on the machine remain the floor
         * underneath and are untouched by any of this; a refusal here only ever stops a call the machine might
         * otherwise have run. */
        const command = commandInCall(payload);
        if (command !== undefined) {
            const stopped = await judgeHostCommand(services, {
                machine: id,
                command,
                conversationId: c.req.query("conversation"),
            });
            if (stopped !== undefined) {
                // An ordinary tool RESULT, not a JSON-RPC error: the model reads the sentence and tells the
                // owner what happened, where a transport failure reads as a broken sandbox and invites a retry.
                return c.json({
                    jsonrpc: "2.0",
                    id: (payload as { id?: unknown }).id,
                    result: { content: [{ type: "text", text: stopped.refusal }], isError: true },
                });
            }
        }
        const request = payload as { id?: unknown; method?: unknown };
        if (request.id === undefined) {
            // A notification expects no answer, so it is forwarded and forgotten, but only to a machine that is
            // actually there; an offline one has nothing to tell.
            void services.hostHub.mcp(id, payload).catch(() => undefined);
            return c.body(null, 202);
        }
        /* A turn loads its MCP servers before it does anything, and half the time a personal device is asleep
         * at that moment. Forwarding the handshake to a machine that cannot answer would fail the connection and
         * take the whole machine out of the turn, the agent would not even know it exists. So the two questions
         * that are ABOUT the connection rather than about the device are answered here when it is offline: the
         * handshake, and the tool list as the machine last reported it. Everything else still goes to the machine,
         * where a call arrives as a plain "this device is asleep" the model can read and pass on. */
        if (!services.hostHub.online(id)) {
            if (request.method === "initialize") {
                return c.json({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        protocolVersion: MCP_PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: { name: `intentic-machine:${id}`, version: services.hostHub.state(id).version ?? "offline" },
                    },
                });
            }
            if (request.method === "tools/list") {
                return c.json({ jsonrpc: "2.0", id: request.id, result: services.hostHub.knownTools(id) ?? { tools: [] } });
            }
        }
        try {
            const answer = await services.hostHub.mcp(id, payload);
            if (request.method === "tools/list") {
                services.hostHub.rememberTools(id, (answer as { result?: unknown }).result);
            }
            return c.json(answer);
        } catch (error) {
            /* An offline machine is a normal state, not a fault: laptops sleep. Answering as a JSON-RPC ERROR
             * rather than an HTTP one is what makes that legible to the model, it reads "this device is
             * asleep" as a tool result and can say so, where a 503 surfaces as an MCP transport failure that
             * looks like a broken sandbox and invites a retry loop. */
            return c.json({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32000, message: errorMessage(error) },
            });
        }
    };

// The owner's view of their machines: the manifest's host capabilities, each with whatever the hub knows about
// it right now. Enrollment state is deliberately part of it, "added but never connected" is the state the
// connect card exists to resolve, and it must be distinguishable from "connected but asleep".
export const hostSummaries = async (services: Services): Promise<HostSummary[]> => {
    const capabilities = await services.capabilities.list();
    return capabilities
        .filter((capability): capability is Extract<Capability, { kind: "host" }> => capability.kind === "host")
        .map((capability) => Object.assign({ id: capability.id, platform: capability.config.platform }, services.hostHub.state(capability.id)));
};
