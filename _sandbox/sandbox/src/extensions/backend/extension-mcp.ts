import { pollUntil } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { RESERVED_MCP_SERVER_NAMES } from "@intentic/sandbox-contract/policy/reserved-servers";
import { type ToolServer, toolServerForCard, toolServersOf } from "@intentic/extension-manifest";
import type { Context } from "hono";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import type { MountTarget, RpcMessage, TurnLease } from "../../agent/tools/turn-mounts.js";
import type { MountCall, MountEndpoints } from "../../agent/tools/turn-mounts.routes.js";
import type { AppEnv } from "../../app-env.js";
import { cachedEnabledExtensions, contributionFor, contributionRegistry } from "../../capabilities/contributions.js";
import type { Services } from "../../composition.js";
import { type ExtensionHost, extensionGranted, type InstalledExtension } from "../../capabilities/extension-inventory/installed-extensions.js";
import { BACKEND_CARD_HEADER, BACKEND_HOST_HEADER } from "./backend-host-config.js";
import { forwardToBackend } from "./backend-proxy.js";
import type { ToolRequest } from "./backend-tools.js";
import { extensionProcessKey } from "../../capabilities/extension-dirs.js";
import { opt } from "../../opt.js";
import { toolGrantsOf, type TurnTickets, turnTickets } from "../turn/tool-grants.js";

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
// enabled extension serving tools of its own that the role's `extensions` shelf grants (absent: every one), named by
// the extension's `name`. The card is the grant for the first, the extension for the second, so neither mounts into a
// turn whose role was not given it. A server named after a daemon server is skipped rather than allowed to shadow it.
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

export const heldTarget = async (backend: Services["extensionBackend"], signal: AbortSignal): Promise<ReturnType<Services["extensionBackend"]["proxyTarget"]>> => {
    await pollUntil(
        () => {
            const state = backend.status().state;
            return backend.proxyTarget() !== undefined || (state !== "starting" && state !== "stopped");
        },
        { intervalMs: RESTART_POLL_MS, timeoutMs: RESTART_HOLD_MS, signal },
    );
    return backend.proxyTarget();
};

export const backendDown = (backend: Services["extensionBackend"]): string => {
    const status = backend.status();
    return `extension backends are ${status.state}${status.detail !== undefined ? `, ${status.detail}` : ""}`;
};

type ToolsDeps = Pick<Services, "extensionBackend" | "capabilities" | "credentialGates" | "credentialGrants"> &
    Partial<Pick<Services, "accountSignInUrls">> &
    ExtensionHost;

// A card the owner put behind a named person (a credential gate) whose tools would use its credential: refused on use
// unless this conversation holds a release, as the gateway refuses a gated card's request and the turn's environment
// leaves out a gated card's variables (secrets/credential-gating.ts). (2026-11-26) A card's tools are handed its
// credential, and since the IMAP and Microsoft 365 cards keep theirs in the backend, this is where their gate holds.
const gateRefusal = async (services: ToolsDeps, card: string, conversationId: string | undefined): Promise<string | undefined> => {
    const gate = await services.credentialGates.forCapability(card);
    if (gate === undefined) {
        return undefined;
    }
    await services.credentialGrants.ready;
    if (conversationId !== undefined && services.credentialGrants.has(conversationId, card) !== undefined) {
        return undefined;
    }
    return `"${card}" needs approval from ${gate.approvers.join(" or ")} before it is used: run \`secrets request ${card} --why "…"\`, and use it from the next turn once one of them releases it`;
};

// One message to the backend host's tools door, and its answer, or why there is none.
const askHost = async (
    backend: { readonly port: number; readonly hostToken: string },
    extension: string,
    body: ToolRequest,
    signal: AbortSignal,
): Promise<{ readonly answer: RpcMessage | undefined } | { readonly refusal: string }> => {
    try {
        const answered = await fetch(`http://127.0.0.1:${backend.port}/tools/${encodeURIComponent(extension)}`, {
            method: "POST",
            headers: { "content-type": "application/json", [BACKEND_HOST_HEADER]: backend.hostToken },
            body: JSON.stringify(body),
            signal,
        });
        if (!answered.ok) {
            return { refusal: `${extension} answered ${answered.status}: ${await answered.text()}` };
        }
        return { answer: ((await answered.json()) as { answer: RpcMessage | null }).answer ?? undefined };
    } catch (error) {
        return { refusal: `${extension} did not answer: ${errorMessage(error)}` };
    }
};

// (2026-11-26) A tools/call's standing on its turn (tool-grants.ts): what the turn holds, and a ticket minted for this
// extension and this call, released once the backend answered. Nothing for any other message.
const callStanding = async (services: ToolsDeps, tickets: TurnTickets, target: { readonly extension: string }, message: RpcMessage, call: MountCall) => {
    if (message.method !== "tools/call") {
        return undefined;
    }
    const grants = await toolGrantsOf(services, target.extension, call.turn);
    const minted = tickets.mint({ extension: target.extension, conversationId: call.conversationId, grants, turn: call.turn });
    return { turn: { ticket: minted.ticket, grants }, release: minted.release };
};

// The door's tools endpoint: one JSON-RPC message to the backend host, which answers it from the extension's
// `api.tools.serve`, handed the card's settings with it, and (2026-11-26) a call its turn's grants and its ticket. No
// headers deadline: the host owns each call's own.
export const createExtensionToolsEndpoint =
    (services: ToolsDeps, tickets: TurnTickets = turnTickets): MountEndpoints["tools"] =>
    async (target, message, call) => {
        const refuse = (text: string): RpcMessage | undefined =>
            message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: text } };
        const card = await cardFor(services, target.extension, target.card);
        if (card === "gone") {
            return refuse(`"${target.card ?? ""}" is no longer a connected card of ${target.extension}`);
        }
        const gated = card === undefined || message.method !== "tools/call" ? undefined : await gateRefusal(services, card.id, call.conversationId);
        if (gated !== undefined) {
            return refuse(gated);
        }
        const backend = await heldTarget(services.extensionBackend, call.signal);
        if (backend === undefined) {
            return refuse(backendDown(services.extensionBackend));
        }
        const standing = await callStanding(services, tickets, target, message, call);
        try {
            const body = { message, ...opt("card", card), ...opt("conversationId", call.conversationId), ...opt("turn", standing?.turn) };
            const answered = await askHost(backend, target.extension, body, call.signal);
            return "refusal" in answered ? refuse(answered.refusal) : answered.answer;
        } finally {
            standing?.release();
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
    (services: Pick<Services, "extensionBackend" | "capabilities" | "serviceProcesses"> & ExtensionHost): MountEndpoints["extension"] =>
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
