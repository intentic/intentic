import { upgradeWebSocket } from "@hono/node-server";
import { type Capability, MCP_PROTOCOL_VERSION, WebExtHelloSchema, WebExtSessionImportSchema, type WebExtSummary } from "@intentic/sandbox-contract";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import type { Context } from "hono";
import type { Services } from "../composition.js";
import { bearerFrom, tokenEquals } from "../auth/auth.js";
import { wrapOutsideContent } from "../guard/outside-content.js";
import type { WebExtClient } from "./webext-hub.js";
import { importBrowserSession } from "./session-import.js";

/* The four surfaces of a connected browser:
 *
 *   /system/webext/connect  the extension's own WebSocket (authenticated by its first frame, webext-protocol).
 *   /system/webext/enroll   redeems the one-time pairing the owner minted in the app.
 *   /system/webext/session  where a handed-over site session arrives (never the socket: it must not be a tool result).
 *   /mcp/webext/:id         the loopback MCP endpoint the AGENT's tools point at, tunnelling JSON-RPC to it.
 *
 * The security shape is the connected computer's (hosts/host.routes.ts): the agent reaches the browser through
 * a URL on this daemon carrying a PER-BOOT bridge token that exists only inside the container, never the
 * extension's own enrollment token, and what it can do at the far end is bounded by switches the extension
 * enforces and by host permissions the browser itself enforces. */

// How long a freshly-opened socket may stay anonymous. It has exactly one job in that window: send the hello.
const AUTH_DEADLINE_MS = 10_000;

/* THE TOOLS WHOSE ANSWER IS THE EXTENSION'S OWN VOICE. Everything else is sealed as outside content on the way
 * back, and the list is written this way round — an allowlist, fail-closed — on purpose.
 *
 * This is the one bridge in the daemon that is NOT a pure pipe, and the reason is what is on the other end. A
 * connected computer answers with its own filesystem and its own commands: material the owner put there. A
 * connected browser answers with WEBSITES, which is the single largest supply of text written specifically to
 * be read by a model and act on it. So page-derived text is wrapped in the same envelope the Front Desk and
 * the listeners use (guard/outside-content.ts), and it is done HERE rather than in the extension so that an
 * old, un-updated or tampered extension build cannot deliver unsealed page text into a turn.
 *
 * Note what is not on the list: `tabs`. A tab's title and URL are page-controlled strings, and a title is the
 * cheapest injection surface on the web. `describe` is, because every field in it is the extension's own
 * account of itself; the two grant tools are, because their answer is a sentence this connector wrote. */
const OWN_VOICE = new Set(["describe", "ask_access", "connect_site"]);

// One MCP result, sealed. Text blocks only: an image has no marker to forge, and the model reads it as pixels.
const sealAnswer = (id: string, tool: string, answer: unknown): unknown => {
    if (OWN_VOICE.has(tool)) {
        return answer;
    }
    const envelope = answer as { result?: { content?: unknown } };
    const content = envelope.result?.content;
    if (!Array.isArray(content)) {
        return answer;
    }
    return {
        ...envelope,
        result: {
            ...envelope.result,
            content: content.map((block) => {
                const part = block as { type?: unknown; text?: unknown };
                return part.type === "text" && typeof part.text === "string"
                    ? Object.assign({}, part, { text: wrapOutsideContent(part.text, { source: `browser:${id}` }) })
                    : block;
            }),
        },
    };
};

/* The extension's socket. Exempt from the bearer middleware like the other upgrades, and authorized the same
 * way a machine's is: no browser session is involved, so there is no ticket to redeem — the enrollment token
 * arrives in the hello frame and resolves WHICH browser this is. The daemon never trusts the extension's claim
 * about its own identity; the pairing already named the capability it enrolls. */
export const createWebExtConnectRoute = (services: Services) =>
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
            onMessage: async (event, ws) => {
                // The ONLY message this handler reads is the hello; from there the socket belongs to the link.
                if (detach !== undefined) {
                    return;
                }
                const hello = WebExtHelloSchema.safeParse(JSON.parse(String(event.data ?? "")));
                if (!hello.success) {
                    services.logger.warn({ err: hello.error }, "webext: first frame was not a hello");
                    ws.close(1008, "unauthorized");
                    return;
                }
                const id = await services.webexts.verify(hello.data.token);
                if (id === undefined) {
                    services.logger.warn("webext: rejected an unenrolled token");
                    ws.close(1008, "unauthorized");
                    return;
                }
                clearTimeout(deadline);
                const socket = ws.raw as unknown as WebSocket;
                const client: WebExtClient = createORPCClient(new RPCLink({ websocket: socket }));
                detach = services.webextHub.attach(id, { client, close: (code, reason) => ws.close(code, reason) });
                services.webextHub.announce(id, hello.data.version);

                /* Scopes first, then facts, in that order and for the host route's reason: the extension
                 * refuses everything until it knows its grant, so pushing before asking is what makes a
                 * reconnect after the owner tightened a switch enforce the NEW one from its first call. */
                const capability = (await services.capabilities.list()).find((entry) => entry.id === id && entry.kind === "webext");
                if (capability?.kind === "webext") {
                    await services.webextHub.pushScopes(id, capability.config);
                }
                services.webextHub.observe(id, await client.describe());
            },
            onClose: () => {
                clearTimeout(deadline);
                detach?.();
            },
            onError: (event) => {
                services.logger.warn({ event: String(event) }, "webext: socket error");
            },
        };
    });

/* The agent's door onto a browser: Streamable HTTP MCP in, the extension's own answer out — sealed.
 *
 * Deliberately not an MCP server: the daemon parses no tool schema and validates no argument, so `tools/list`
 * is whatever the extension installed in that browser knows how to do today, and a new tool needs a Web Store
 * release rather than a sandbox one. The one thing it does to the payload is the envelope above.
 *
 * A message with no id is a notification: delivered and answered 202, per the transport spec. GET is the
 * optional server→client stream, which this has none of, so it is refused rather than left hanging. */
export const createWebExtMcpRoute =
    (services: Services) =>
    async (c: Context): Promise<Response> => {
        if (!tokenEquals(bearerFrom(c.req.header("authorization")) ?? "", services.webextBridgeToken)) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const id = c.req.param("id") ?? "";
        if (!(await services.webexts.enrolled(id))) {
            return c.json({ error: `no connected browser named "${id}"` }, 404);
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
        const request = payload as { id?: unknown; method?: unknown; params?: { name?: unknown } };
        if (request.id === undefined) {
            void services.webextHub.mcp(id, payload).catch(() => undefined);
            return c.body(null, 202);
        }
        /* A turn loads its MCP servers before it does anything, and a browser is shut more often than a laptop
         * is asleep. So the two questions that are ABOUT the connection rather than about the browser are
         * answered here when it is offline — the handshake, and the tool list as last reported — and everything
         * else still goes to the browser, where it arrives as a readable "that browser is closed". */
        if (!services.webextHub.online(id)) {
            if (request.method === "initialize") {
                return c.json({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        protocolVersion: MCP_PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        // "offline" rather than the extension's build number, which this daemon only learns
                        // from a live socket: an answer invented here must not claim to know what it does not.
                        serverInfo: { name: `intentic-webext:${id}`, version: "offline" },
                    },
                });
            }
            if (request.method === "tools/list") {
                return c.json({ jsonrpc: "2.0", id: request.id, result: services.webextHub.knownTools(id) ?? { tools: [] } });
            }
        }
        try {
            const answer = await services.webextHub.mcp(id, payload);
            if (request.method === "tools/list") {
                services.webextHub.rememberTools(id, (answer as { result?: unknown }).result);
                return c.json(answer);
            }
            if (request.method === "tools/call") {
                return c.json(sealAnswer(id, typeof request.params?.name === "string" ? request.params.name : "", answer));
            }
            return c.json(answer);
        } catch (error) {
            // A closed browser is a normal state, not a fault. As a JSON-RPC ERROR the model reads it as a tool
            // result and can say "open your browser"; as an HTTP 503 it looks like a broken sandbox.
            return c.json({
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
            });
        }
    };

/* Where a handed-over session lands. Authenticated by the extension's OWN enrollment token as a bearer (the
 * runner-credentials precedent), which is what makes this door safe to exempt from the browser's Google auth:
 * the only thing that can post here is an extension the owner paired, and it can only ever write into this
 * sandbox's own profiles. The payload is never logged, and the answer never quotes it. */
export const createWebExtSessionRoute =
    (services: Services) =>
    async (c: Context): Promise<Response> => {
        const id = await services.webexts.verify(bearerFrom(c.req.header("authorization")) ?? "");
        if (id === undefined) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const parsed = WebExtSessionImportSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            return c.json({ ok: false, message: "That session payload is not one this sandbox can read." }, 400);
        }
        const result = await importBrowserSession(parsed.data, {
            workspaceRoot: services.workspace.root,
            capabilities: await services.capabilities.list(),
        });
        services.logger.info({ browser: id, account: parsed.data.account, ok: result.ok }, "webext: session handed over");
        return c.json(result, result.ok ? 200 : 409);
    };

// The owner's view of their browsers: the manifest's webext capabilities, each with whatever the hub can say
// about it right now. Enrollment state is part of it — "added but never paired" is the state the connect card
// exists to resolve, and it must be distinguishable from "paired but the browser is shut".
export const webextSummaries = async (services: Services): Promise<WebExtSummary[]> => {
    const capabilities = await services.capabilities.list();
    return await Promise.all(
        capabilities
            .filter((capability): capability is Extract<Capability, { kind: "webext" }> => capability.kind === "webext")
            .map(async (capability) =>
                Object.assign({ id: capability.id, platform: capability.config.platform }, await services.webextHub.state(capability.id)),
            ),
    );
};
