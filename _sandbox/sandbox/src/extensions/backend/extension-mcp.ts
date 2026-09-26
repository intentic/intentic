import { type Capability, RESERVED_MCP_SERVER_NAMES } from "@intentic/sandbox-contract";
import { type ToolServer, toolServerForCard, toolServersOf } from "@intentic/extension-manifest";
import type { Context } from "hono";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import type { MountTarget, RpcMessage, TurnLease } from "../../agent/tools/turn-mounts.js";
import type { MountCall, MountEndpoints } from "../../agent/tools/turn-mounts.routes.js";
import type { AppEnv } from "../../app-env.js";
import { cachedEnabledExtensions, contributionFor, contributionRegistry } from "../../capabilities/contributions.js";
import type { Services } from "../../composition.js";
import { extensionProcessKey } from "../extension-processes.js";
import { type ExtensionHost, extensionGranted, type InstalledExtension } from "../installed-extensions.js";
import { BACKEND_CARD_HEADER, BACKEND_HOST_HEADER } from "./backend-host-config.js";
import { forwardToBackend } from "./backend-proxy.routes.js";

// An extension's tools (`contributes.tools`, or a cli card's `mcp`, its alias for one release), mounted into every turn
// granted them at the daemon's one MCP door on the turn's lease, like peer bridges: the door checks the turn's bearer against
// what that turn mounted and strips it before anything reaches the extension. Served once, for every session and every
// runtime, where a stdio server in a plugin's `.mcp.json` was spawned per Claude Code session and reached nothing else.

// What a server needs to be mountable at all: the backend bundle that serves it, or the process whose port answers.
const servable = (extension: InstalledExtension, server: ToolServer): boolean =>
    server.serve.by === "process"
        ? (extension.manifest.contributes?.processes ?? []).some((process) => process.name === (server.serve as { process: string }).process)
        : extension.manifest.server !== undefined;

const targetOf = (extension: InstalledExtension, server: ToolServer, card: string | undefined): MountTarget =>
    server.serve.by === "host"
        ? { kind: "tools", extension: extension.id, ...(card === undefined ? {} : { card }) }
        : {
              kind: "extension",
              extension: extension.id,
              path: server.serve.path,
              ...(card === undefined ? {} : { card }),
              ...(server.serve.by === "process" ? { process: server.serve.process } : {}),
          };

// The extension and server a granted cli card's tools come from, if its kind serves any.
const cardServerOf = async (
    host: ExtensionHost,
    capability: Capability,
): Promise<{ readonly extension: InstalledExtension; readonly server: ToolServer } | undefined> => {
    if (capability.kind !== "cli") {
        return undefined;
    }
    const resolved = contributionFor(await contributionRegistry(host), "cli", capability.config);
    if (resolved === undefined) {
        return undefined;
    }
    const server = toolServerForCard(resolved.extension.manifest, resolved.spec.id);
    return server !== undefined && servable(resolved.extension, server) ? { extension: resolved.extension, server } : undefined;
};

// One server per granted card whose kind serves tools, named by the card's id like mcp-kind cards and peers, and one per
// enabled extension serving tools of its own that the persona's `extensions` shelf grants (absent: every one), named by
// the extension's `name`. The card is the grant for the first, the extension for the second, so neither mounts into a
// turn whose persona was not given it. A server named after a daemon server is skipped rather than allowed to shadow it.
export const extensionMcpToolsOf = async (
    services: ExtensionHost,
    granted: readonly Capability[],
    lease: Pick<TurnLease, "open">,
    extensions: readonly string[] | undefined,
): Promise<AgentTool[]> => {
    const tools: AgentTool[] = [];
    for (const capability of granted) {
        if (capability.kind !== "cli" || RESERVED_MCP_SERVER_NAMES.has(capability.id)) {
            continue;
        }
        const served = await cardServerOf(services, capability);
        if (served !== undefined) {
            tools.push(lease.open({ name: capability.id, target: targetOf(served.extension, served.server, capability.id) }));
        }
    }
    for (const extension of await cachedEnabledExtensions(services)) {
        if (!extensionGranted(extensions, extension.id)) {
            continue;
        }
        const name = extension.manifest.name;
        for (const server of toolServersOf(extension.manifest)) {
            if (server.perCard === undefined && servable(extension, server) && !RESERVED_MCP_SERVER_NAMES.has(name)) {
                tools.push(lease.open({ name, target: targetOf(extension, server, undefined) }));
            }
        }
    }
    return tools;
};

// A card's settings as the daemon holds them now, secrets included, strings only (a connection is env-shaped), and only
// while the card still comes from the extension the turn mounted it for: a card whose kind moved to another extension
// since is not handed to the first.
const cardFor = async (
    services: Pick<Services, "capabilities"> & ExtensionHost,
    extension: string,
    card: string | undefined,
): Promise<{ readonly id: string; readonly config: Record<string, string> } | "gone" | undefined> => {
    if (card === undefined) {
        return undefined;
    }
    const capability = await services.capabilities.get(card);
    const served = capability === undefined ? undefined : await cardServerOf(services, capability);
    if (capability === undefined || served?.extension.id !== extension) {
        return "gone";
    }
    const config = Object.fromEntries(Object.entries(capability.config).filter(([, value]) => typeof value === "string")) as Record<string, string>;
    return { id: capability.id, config };
};

// The backend host restarts on every change to the extension set; a request arriving meanwhile waits this long for it
// to come back rather than failing the agent's call over a restart it cannot see.
const RESTART_HOLD_MS = 15_000;
const RESTART_POLL_MS = 200;

const heldTarget = async (backend: Services["extensionBackend"], signal: AbortSignal): Promise<ReturnType<Services["extensionBackend"]["proxyTarget"]>> => {
    const until = Date.now() + RESTART_HOLD_MS;
    for (;;) {
        const target = backend.proxyTarget();
        const state = backend.status().state;
        if (target !== undefined || (state !== "starting" && state !== "stopped") || Date.now() >= until || signal.aborted) {
            return target;
        }
        await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_MS));
    }
};

const backendDown = (backend: Services["extensionBackend"]): string => {
    const status = backend.status();
    return `extension backends are ${status.state}${status.detail !== undefined ? `, ${status.detail}` : ""}`;
};

type ToolsDeps = Pick<Services, "extensionBackend" | "capabilities"> & ExtensionHost;

// The door's tools endpoint: one JSON-RPC message to the backend host, which answers it from the extension's
// `api.tools.serve`, handed the card's settings with it. No headers deadline: the host owns each call's own.
export const createExtensionToolsEndpoint =
    (services: ToolsDeps): MountEndpoints["tools"] =>
    async (target, message, call) => {
        const refuse = (text: string): RpcMessage | undefined =>
            message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } };
        const card = await cardFor(services, target.extension, target.card);
        if (card === "gone") {
            return refuse(`"${target.card ?? ""}" is no longer a connected card of ${target.extension}`);
        }
        const backend = await heldTarget(services.extensionBackend, call.signal);
        if (backend === undefined) {
            return refuse(backendDown(services.extensionBackend));
        }
        try {
            const answered = await fetch(`http://127.0.0.1:${backend.port}/tools/${encodeURIComponent(target.extension)}`, {
                method: "POST",
                headers: { "content-type": "application/json", [BACKEND_HOST_HEADER]: backend.hostToken },
                body: JSON.stringify({ message, ...(card === undefined ? {} : { card }), ...(call.conversationId === undefined ? {} : { conversationId: call.conversationId }) }),
                signal: call.signal,
            });
            if (!answered.ok) {
                return refuse(`${target.extension} answered ${answered.status}: ${await answered.text()}`);
            }
            return ((await answered.json()) as { answer: RpcMessage | null }).answer ?? undefined;
        } catch (error) {
            return refuse(`${target.extension} did not answer: ${error instanceof Error ? error.message : String(error)}`);
        }
    };

// How long an endpoint that speaks the transport itself may take to its first byte. The /x proxy's 20 s is tuned for a
// browser's HTTP/2 connection, where a stalled panel holds streams everything else shares; an agent's tool call is one
// request of its own, and a slow remote API behind it is ordinary.
const TOOL_HEADERS_DEADLINE_MS = 10 * 60_000;

const encodeCard = (card: { readonly id: string; readonly config: Record<string, string> }): string =>
    Buffer.from(JSON.stringify(card), "utf8").toString("base64url");

// The door's proxy endpoint, for an extension endpoint that answers Streamable HTTP itself: onto the card's path in the
// backend namespace (which /x/* itself refuses) or onto a declared process's port, with the card's settings in
// `x-intentic-card` so the extension need not re-read them.
export const createExtensionMcpEndpoint =
    (services: ToolsDeps & Pick<Services, "serviceProcesses">): MountEndpoints["extension"] =>
    async (target, c: Context<AppEnv>, call: MountCall) => {
        const card = await cardFor(services, target.extension, target.card);
        if (card === "gone") {
            return c.json({ error: `"${target.card ?? ""}" is no longer a connected card of ${target.extension}` }, 404);
        }
        const suffix = `${target.path}${card === undefined ? "" : `/${encodeURIComponent(card.id)}`}`;
        const headers = card === undefined ? {} : { [BACKEND_CARD_HEADER]: encodeCard(card) };
        const search = new URL(c.req.url).search;
        if (target.process !== undefined) {
            const port = services.serviceProcesses.portOf(extensionProcessKey(target.extension, target.process));
            if (port === undefined) {
                return c.json({ error: `${target.extension}'s process "${target.process}" is not running` }, 503);
            }
            return forwardToBackend(c, { port, headers }, new URL(`/${suffix}${search}`, c.req.url), target.extension, TOOL_HEADERS_DEADLINE_MS);
        }
        const backend = await heldTarget(services.extensionBackend, call.signal);
        if (backend === undefined) {
            return c.json({ error: backendDown(services.extensionBackend) }, 503);
        }
        const url = new URL(`/x/${encodeURIComponent(target.extension)}/${suffix}${search}`, c.req.url);
        return forwardToBackend(c, { port: backend.port, headers: { ...headers, [BACKEND_HOST_HEADER]: backend.hostToken } }, url, target.extension, TOOL_HEADERS_DEADLINE_MS);
    };
