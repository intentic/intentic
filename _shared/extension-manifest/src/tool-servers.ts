import type { ExtensionManifest } from "./manifest.js";

// Every MCP server one manifest serves the agent, whichever way it declares it: `contributes.tools`, or a cli card's
// `mcp` (the alias kept one release, points/capabilities.ts). One reading, so the daemon's mounts, the /x refusal and
// the effects a card discloses cannot disagree about what a manifest serves.

export type ToolServe =
    // The host serves what the backend's `api.tools.serve` returns; nothing in the namespace answers MCP itself.
    | { readonly by: "host" }
    // The backend answers Streamable HTTP itself, at this path in its /x namespace.
    | { readonly by: "backend"; readonly path: string }
    // A declared process answers it on its port, at this path.
    | { readonly by: "process"; readonly process: string; readonly path: string };

export interface ToolServer {
    // The cli card kind whose every granted card gets a server named by the card's id; absent, one server for the
    // extension named by its `name`.
    readonly perCard?: string;
    readonly serve: ToolServe;
}

export const toolServersOf = (manifest: ExtensionManifest): ToolServer[] => {
    const servers: ToolServer[] = [];
    const tools = manifest.contributes?.tools;
    if (tools !== undefined) {
        const serve: ToolServe =
            tools.process !== undefined
                ? { by: "process", process: tools.process, path: tools.path ?? "" }
                : tools.path !== undefined
                  ? { by: "backend", path: tools.path }
                  : { by: "host" };
        servers.push({ ...(tools.perCard === undefined ? {} : { perCard: tools.perCard }), serve });
    }
    for (const card of manifest.contributes?.capabilities ?? []) {
        // `tools` naming the same card wins: a manifest may keep `mcp` for a host older than `tools`.
        if (card.kind === "cli" && card.mcp !== undefined && tools?.perCard !== card.id) {
            servers.push({ perCard: card.id, serve: { by: "backend", path: card.mcp } });
        }
    }
    return servers;
};

// The server a card of this cli kind gets, if the manifest serves one per card of it.
export const toolServerForCard = (manifest: ExtensionManifest, cardKind: string): ToolServer | undefined =>
    toolServersOf(manifest).find((server) => server.perCard === cardKind);

// The /x paths (relative to the namespace) the backend answers MCP at itself: what /x/* refuses, since only the door
// checks the calling turn's lease.
export const backendToolPathsOf = (manifest: ExtensionManifest): string[] =>
    toolServersOf(manifest).flatMap((server) => (server.serve.by === "backend" ? [server.serve.path] : []));
