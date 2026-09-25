import { type Capability, RESERVED_MCP_SERVER_NAMES } from "@intentic/sandbox-contract";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import type { TurnLease } from "../../agent/tools/turn-mounts.js";
import type { MountEndpoints } from "../../agent/tools/turn-mounts.routes.js";
import { contributionFor, contributionRegistry } from "../../capabilities/contributions.js";
import type { Services } from "../../composition.js";
import type { ExtensionHost } from "../installed-extensions.js";
import { forwardToBackend } from "./backend-proxy.routes.js";

// An extension card's MCP endpoint (a cli contribution's `mcp`), served by the one backend host the sandbox already
// runs. A stdio server in the extension's agent plugin would be spawned again by every session; this is one handler
// shared by all of them. Mounted into a turn the way peer bridges are, on the turn's lease: the daemon's one MCP door
// checks the conversation's bearer against the cards that turn was granted, and strips it before the request reaches
// the backend.

// Where the card's endpoint lives in its backend's /x namespace; undefined when its contribution declares none, or the
// declaring extension has no backend to serve it.
const endpointOf = async (
    host: ExtensionHost,
    capability: Capability,
): Promise<{ readonly extension: string; readonly path: string } | undefined> => {
    if (capability.kind !== "cli") {
        return undefined;
    }
    const resolved = contributionFor(await contributionRegistry(host), "cli", capability.config);
    if (resolved?.spec.kind !== "cli" || resolved.spec.mcp === undefined || resolved.extension.manifest.server === undefined) {
        return undefined;
    }
    return {
        extension: resolved.extension.id,
        path: `/x/${encodeURIComponent(resolved.extension.id)}/${resolved.spec.mcp}/${encodeURIComponent(capability.id)}`,
    };
};

// One server per granted card, named by its id like mcp-kind cards and peers, mounted on the turn's lease so the
// conversation's bearer reaches exactly these cards while the turn runs. A card named after a daemon server is skipped
// rather than allowed to shadow it: cli ids were never checked against that list, since until now they minted no server.
export const extensionMcpToolsOf = async (
    services: ExtensionHost,
    granted: readonly Capability[],
    lease: Pick<TurnLease, "open">,
): Promise<AgentTool[]> => {
    const cards = granted.filter((capability) => capability.kind === "cli" && !RESERVED_MCP_SERVER_NAMES.has(capability.id));
    // The registry walks every installed manifest; a turn with no cli card at all has nothing to look up.
    if (cards.length === 0) {
        return [];
    }
    const tools: AgentTool[] = [];
    for (const capability of cards) {
        if ((await endpointOf(services, capability)) !== undefined) {
            tools.push(lease.open({ name: capability.id, target: { kind: "extension", card: capability.id } }));
        }
    }
    return tools;
};

// The door's extension endpoint (agent/tools/turn-mounts.routes.ts), reached once the bearer's lease holds this card:
// the card, then the same forward /x/* uses, onto the card's path, which /x/* itself refuses. Everything the backend
// reads about the card (credentials, switches) it reads from the daemon by the id at the end of that path.
export const createExtensionMcpEndpoint =
    (services: Pick<Services, "extensionBackend" | "capabilities"> & ExtensionHost): MountEndpoints["extension"] =>
    async (target, c) => {
        const id = target.card;
        const capability = await services.capabilities.get(id);
        const endpoint = capability === undefined ? undefined : await endpointOf(services, capability);
        if (endpoint === undefined) {
            return c.json({ error: `no connected card named "${id}" serves MCP` }, 404);
        }
        const backend = services.extensionBackend.proxyTarget();
        if (backend === undefined) {
            const status = services.extensionBackend.status();
            return c.json({ error: `extension backends are ${status.state}${status.detail !== undefined ? `, ${status.detail}` : ""}` }, 503);
        }
        const url = new URL(endpoint.path, c.req.url);
        url.search = new URL(c.req.url).search;
        return forwardToBackend(c, backend, url, endpoint.extension);
    };
