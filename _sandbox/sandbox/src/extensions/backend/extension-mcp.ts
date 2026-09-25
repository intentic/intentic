import { createHash, randomBytes } from "node:crypto";
import { type Capability, RESERVED_MCP_SERVER_NAMES } from "@intentic/sandbox-contract";
import type { Context } from "hono";
import type { AgentTool } from "../../agent/tools/agent-tools.js";
import type { AppEnv } from "../../app-env.js";
import { bearerFrom } from "../../auth/auth.js";
import { contributionFor, contributionRegistry } from "../../capabilities/contributions.js";
import type { Services } from "../../composition.js";
import type { ExtensionHost } from "../installed-extensions.js";
import { forwardToBackend } from "./backend-proxy.routes.js";

// An extension card's MCP endpoint (a cli contribution's `mcp`), served by the one backend host the sandbox already
// runs. A stdio server in the extension's agent plugin would be spawned again by every session; this is one handler
// shared by all of them. Mounted into a turn the way peer bridges are: a loopback URL per granted card, carrying the
// turn's own mount bearer, which this door checks against the cards that turn was granted and strips before the request
// reaches the backend.

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

// ---- the turns' mounts: which cards a presented bearer may reach, for as long as its turn runs ----------------------

// A conversation keeps one bearer across its turns, because an ACP agent's warm session keeps the MCP config it was
// opened with; each turn leases that bearer the cards it was granted, and between turns it reaches nothing. A turn with
// no conversation gets a bearer of its own, gone when it ends.
interface Lease {
    readonly cards: ReadonlySet<string>;
    readonly openedAt: number;
}

interface Mount {
    readonly token: string;
    readonly leases: Map<string, Lease>;
    idleSince: number;
}

// A turn that was planned but never run leaves its lease behind with nothing to release it; a day bounds the map, like
// the browser routers' (browser-router.ts), and a lease that old is past any turn.
const ABANDONED_MS = 24 * 3_600_000;

// One turn's hold on its granted cards: the bearer its tool config carries, and the release its loop calls when it ends.
export interface ExtensionMcpMount {
    readonly token: string;
    readonly release: () => void;
}

export interface ExtensionMcpMounts {
    readonly open: (cards: readonly string[], conversationId?: string) => ExtensionMcpMount;
    // The cards a presented bearer reaches right now: undefined for a bearer that was never minted (or was swept), empty
    // for one whose turns have all ended.
    readonly reach: (token: string | undefined) => ReadonlySet<string> | undefined;
    readonly closeAll: () => void;
}

// Keyed by the bearer's digest, so a lookup compares no secret byte by byte and the map holds nothing a dump could replay.
const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");

export const createExtensionMcpMounts = (now: () => number = Date.now): ExtensionMcpMounts => {
    const mounts = new Map<string, Mount>();
    const keyOf = new Map<string, string>();
    const drop = (key: string): void => {
        const mount = mounts.get(key);
        if (mount !== undefined) {
            keyOf.delete(digestOf(mount.token));
            mounts.delete(key);
        }
    };
    const sweep = (): void => {
        const cutoff = now() - ABANDONED_MS;
        for (const [key, mount] of mounts) {
            for (const [id, lease] of mount.leases) {
                if (lease.openedAt <= cutoff) {
                    mount.leases.delete(id);
                }
            }
            if (mount.leases.size === 0 && mount.idleSince <= cutoff) {
                drop(key);
            }
        }
    };
    return {
        open: (cards, conversationId) => {
            sweep();
            const key = conversationId === undefined ? `turn:${randomBytes(12).toString("hex")}` : `conversation:${conversationId}`;
            let mount = mounts.get(key);
            if (mount === undefined) {
                mount = { token: randomBytes(32).toString("hex"), leases: new Map(), idleSince: now() };
                mounts.set(key, mount);
                keyOf.set(digestOf(mount.token), key);
            }
            const held = mount;
            const leaseId = randomBytes(8).toString("hex");
            held.leases.set(leaseId, { cards: new Set(cards), openedAt: now() });
            return {
                token: held.token,
                release: () => {
                    if (!held.leases.delete(leaseId) || held.leases.size > 0) {
                        return;
                    }
                    held.idleSince = now();
                    if (conversationId === undefined) {
                        drop(key);
                    }
                },
            };
        },
        reach: (token) => {
            const key = token === undefined || token === "" ? undefined : keyOf.get(digestOf(token));
            const mount = key === undefined ? undefined : mounts.get(key);
            return mount === undefined ? undefined : new Set([...mount.leases.values()].flatMap((lease) => [...lease.cards]));
        },
        closeAll: () => {
            mounts.clear();
            keyOf.clear();
        },
    };
};

// A turn's extension-card servers and the release that ends their mount.
export interface ExtensionMcpTools {
    readonly tools: AgentTool[];
    readonly release: () => void;
}

const NO_TOOLS: ExtensionMcpTools = { tools: [], release: () => undefined };

// One server per granted card, named by its id like mcp-kind cards and peers, all carrying one mount bearer that
// reaches exactly these cards until the turn releases it. A card named after a daemon server is skipped rather than
// allowed to shadow it: cli ids were never checked against that list, since until now they minted no server.
export const extensionMcpToolsOf = async (
    services: ExtensionHost & Pick<Services, "extensionMcpMounts">,
    granted: readonly Capability[],
    daemonPort: number,
    conversationId?: string,
): Promise<ExtensionMcpTools> => {
    const cards = granted.filter((capability) => capability.kind === "cli" && !RESERVED_MCP_SERVER_NAMES.has(capability.id));
    // The registry walks every installed manifest; a turn with no cli card at all has nothing to look up.
    if (cards.length === 0) {
        return NO_TOOLS;
    }
    const served: string[] = [];
    for (const capability of cards) {
        if ((await endpointOf(services, capability)) !== undefined) {
            served.push(capability.id);
        }
    }
    if (served.length === 0) {
        return NO_TOOLS;
    }
    const mount = services.extensionMcpMounts.open(served, conversationId);
    return {
        tools: served.map((id) => ({
            name: id,
            url: `http://127.0.0.1:${daemonPort}/mcp/extensions/${encodeURIComponent(id)}`,
            token: mount.token,
        })),
        release: mount.release,
    };
};

// The door: the bearer, then whether its turn was granted this card, then the card, then the same forward /x/* uses,
// onto the card's path. Everything the backend reads about the card (credentials, switches) it reads from the daemon by
// the id at the end of that path.
export const createExtensionMcpRoute =
    (services: Pick<Services, "extensionBackend" | "extensionMcpMounts" | "capabilities"> & ExtensionHost) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const reach = services.extensionMcpMounts.reach(bearerFrom(c.req.header("authorization")));
        if (reach === undefined) {
            return c.json({ error: "unauthorized" }, 401);
        }
        const id = c.req.param("id") ?? "";
        // Whatever card id the path names, a bearer reaches only what its own turn was granted, and nothing once it ends.
        if (!reach.has(id)) {
            return c.json({ error: `"${id}" is not a card this turn was granted` }, 403);
        }
        const capability = await services.capabilities.get(id);
        const endpoint = capability === undefined ? undefined : await endpointOf(services, capability);
        if (endpoint === undefined) {
            return c.json({ error: `no connected card named "${id}" serves MCP` }, 404);
        }
        const target = services.extensionBackend.proxyTarget();
        if (target === undefined) {
            const backend = services.extensionBackend.status();
            return c.json({ error: `extension backends are ${backend.state}${backend.detail !== undefined ? `, ${backend.detail}` : ""}` }, 503);
        }
        const url = new URL(endpoint.path, c.req.url);
        url.search = new URL(c.req.url).search;
        return forwardToBackend(c, target, url, endpoint.extension);
    };
