import { pollFor, sleep } from "@intentic/base/async";
import type { OpenCodeClient } from "@opencode/client";
import type { McpRemoteConfig, OpenCodeMcpServer } from "../opencode-mcp.js";

// How long a just-added server gets to connect; past it the turn goes without its tools rather than waiting longer.
const MCP_CONNECT_MS = 15_000;
const MCP_POLL_MS = 25;
// OpenCode rebuilds a directory's tool list 100ms after a server's tools change (2.0.26), and a session created before
// that sees the old list. So a turn whose servers just changed waits this long past the connect before it prompts.
const MCP_SETTLE_MS = 300;

// The MCP servers turns hold in each directory. OpenCode keeps one client per server name there, and two turns of one
// conversation can hold the same name at once, so each name's client carries its newest holder's config (that turn's
// bearer) and is removed once the last holder lets go. Changes to one name run in order, so the client ends on the
// newest holder whichever call lands first.
export const mcpHolds = (client: () => Promise<OpenCodeClient>) => {
    const holders = new Map<string, { readonly id: symbol; readonly config: McpRemoteConfig }[]>();
    // Which holder each name's client was last set to; absent once removed.
    const applied = new Map<string, symbol>();
    const settling = new Map<string, Promise<boolean>>();
    const keyOf = (directory: string, name: string): string => `${directory}\u0000${name}`;

    const connectedOrGone = async (opencode: OpenCodeClient, directory: string, name: string): Promise<void> => {
        await pollFor(
            async () => {
                const listed = await opencode.mcp.list({ location: { directory } });
                const status = listed.data.find((server) => server.name === name)?.status.status;
                // add() schedules reconciliation: the name can be absent before its pending entry appears.
                return status === undefined || status === "pending" ? undefined : true;
            },
            { intervalMs: MCP_POLL_MS, until: Date.now() + MCP_CONNECT_MS },
        );
    };

    // Brings one name's client in line with its newest holder, after whatever change to it is already under way.
    // Resolves to whether this call changed what the directory offers.
    const settle = (opencode: OpenCodeClient, directory: string, name: string): Promise<boolean> => {
        const key = keyOf(directory, name);
        const next = (settling.get(key) ?? Promise.resolve(false))
            .then(async () => {
                const newest = holders.get(key)?.at(-1);
                if (applied.get(key) === newest?.id) {
                    return false;
                }
                if (newest === undefined) {
                    applied.delete(key);
                    await opencode.mcp.remove({ server: name, location: { directory } });
                    return true;
                }
                applied.set(key, newest.id);
                await opencode.mcp.add({ server: name, location: { directory }, config: newest.config });
                await connectedOrGone(opencode, directory, name);
                return true;
            })
            // allow(silent-catch): a server OpenCode could not mount is a tool the turn goes without, not a failed turn
            .catch(() => false);
        settling.set(key, next);
        void next.then(() => {
            if (settling.get(key) === next) {
                settling.delete(key);
            }
        });
        return next;
    };

    return {
        mount: async (directory: string, servers: readonly OpenCodeMcpServer[]): Promise<() => Promise<void>> => {
            if (servers.length === 0) {
                return async () => {};
            }
            const opencode = await client();
            const id = Symbol("mount");
            for (const server of servers) {
                const key = keyOf(directory, server.name);
                holders.set(key, [...(holders.get(key) ?? []), { id, config: server.config }]);
            }
            const changed = await Promise.all(servers.map((server) => settle(opencode, directory, server.name)));
            if (changed.some(Boolean)) {
                await sleep(MCP_SETTLE_MS);
            }
            let released = false;
            return async () => {
                if (released) {
                    return;
                }
                released = true;
                for (const server of servers) {
                    const key = keyOf(directory, server.name);
                    const left = (holders.get(key) ?? []).filter((holder) => holder.id !== id);
                    if (left.length === 0) {
                        holders.delete(key);
                    } else {
                        holders.set(key, left);
                    }
                }
                await Promise.all(servers.map((server) => settle(opencode, directory, server.name)));
            };
        },
        // A stopped server took every client with it.
        forget: (): void => {
            holders.clear();
            applied.clear();
            settling.clear();
        },
    };
};
