import { createHash, randomBytes } from "node:crypto";
import { type AgentEvent, rawRoutePath } from "@intentic/sandbox-contract";
import type { AgentTool } from "./agent-tools.js";

// Every MCP endpoint the daemon hosts for a turn, behind one door (`/mcp/<name>`, turn-mounts.routes.ts): the turn's
// browser routers, the connected machines and browsers it was granted, and its extension cards' endpoints. A
// conversation holds one bearer across its turns, because an ACP agent's warm session keeps the MCP config it was opened
// with; each turn leases that bearer the servers it mounted, by name, and between turns the bearer reaches nothing. A turn
// with no conversation gets a bearer of its own, gone when it ends.

// Where the door answers, up to and excluding the server name.
export const TURN_MOUNT_BASE = rawRoutePath("ALL /mcp/{mount}").replace("/{mount}", "");

// One JSON-RPC 2.0 message, the only thing the door's own endpoints read or answer.
export interface RpcMessage {
    readonly jsonrpc?: "2.0";
    readonly id?: string | number | null;
    readonly method?: string;
    readonly params?: Record<string, unknown>;
    readonly result?: unknown;
    readonly error?: unknown;
}

// One MCP server living in this daemon for a turn (a browser router, browser/tools/browser-router.ts), by what the door
// and the lease need of it. Structural, so this module imports no subsystem and every runtime can reach it.
export interface InProcessServer {
    // Answers one client message; undefined for a notification. `signal` is the HTTP request's own.
    readonly handle: (message: RpcMessage, signal?: AbortSignal) => Promise<RpcMessage | undefined>;
    readonly close: () => void;
}

// What one mounted name reaches. The door answers for the target, never for the name: a bearer that names a server its
// current lease does not hold is refused, whatever it names.
export type MountTarget =
    // A turn's own browser router, living in this daemon; closed with the lease that opened it.
    | { readonly kind: "browser"; readonly router: InProcessServer }
    // A connected machine (device card) or one of the owner's own browsers (webext card), through its peer socket.
    | { readonly kind: "device"; readonly id: string }
    | { readonly kind: "webext"; readonly id: string }
    // An extension's tools (`contributes.tools`), answered by its backend host from `api.tools.serve`; `card` names the
    // card a per-card server was mounted for, whose settings the door hands over with each message.
    | { readonly kind: "tools"; readonly extension: string; readonly card?: string }
    // An extension's MCP endpoint that speaks Streamable HTTP itself: at `path` in its backend namespace, or on a declared
    // process's port; with a card, at `<path>/<card>`.
    | { readonly kind: "extension"; readonly extension: string; readonly card?: string; readonly path: string; readonly process?: string };

export interface MountSpec {
    // The MCP server name: what the model sees as `mcp__<name>__…`, and the path segment the door is reached at.
    readonly name: string;
    readonly target: MountTarget;
    // How long a client should wait on one call, where a runtime takes it (a browser's page can take minutes).
    readonly timeoutMs?: number;
}

// One turn's hold: every server it mounts rides the conversation's bearer, and release ends the turn's reach (and closes
// what only it held, its browser routers) however the turn ended.
export interface TurnLease {
    readonly open: (mount: MountSpec) => AgentTool;
    readonly release: () => void;
}

// What the door resolved a request to, or why it would not.
export type MountReach =
    | { readonly target: MountTarget; readonly conversationId: string | undefined }
    // unknown: no live bearer by that value; unleased: a live bearer whose turn holds no server by that name right now.
    | { readonly refused: "unknown" | "unleased" };

export interface TurnMounts {
    readonly lease: (conversationId?: string) => TurnLease;
    readonly resolve: (token: string | undefined, name: string) => MountReach;
    readonly closeAll: () => void;
}

interface Lease {
    readonly targets: Map<string, MountTarget>;
    readonly openedAt: number;
}

interface Mount {
    readonly token: string;
    readonly conversationId: string | undefined;
    readonly leases: Map<string, Lease>;
    idleSince: number;
}

// A turn that was planned but never run leaves its lease behind with nothing to release it; a day bounds the map, and a
// lease that old is past any turn. Its browser routers hold no process until a call spawns one.
const ABANDONED_MS = 24 * 3_600_000;

// Keyed by the bearer's digest, so a lookup compares no secret byte by byte and the map holds nothing a dump could replay.
const digestOf = (token: string): string => createHash("sha256").update(token).digest("hex");

const closeTarget = (target: MountTarget): void => {
    if (target.kind === "browser") {
        target.router.close();
    }
};

const closeLease = (lease: Lease): void => {
    for (const target of lease.targets.values()) {
        closeTarget(target);
    }
    lease.targets.clear();
};

export const createTurnMounts = (deps: {
    // Where the door answers, up to and excluding the name: http://127.0.0.1:<port>/mcp
    readonly baseUrl: () => string;
    readonly now?: () => number;
}): TurnMounts => {
    const now = deps.now ?? Date.now;
    const mounts = new Map<string, Mount>();
    const keyOf = new Map<string, string>();
    const drop = (key: string): void => {
        const mount = mounts.get(key);
        if (mount === undefined) {
            return;
        }
        for (const lease of mount.leases.values()) {
            closeLease(lease);
        }
        keyOf.delete(digestOf(mount.token));
        mounts.delete(key);
    };
    const sweep = (): void => {
        const cutoff = now() - ABANDONED_MS;
        for (const [key, mount] of mounts) {
            for (const [id, lease] of mount.leases) {
                if (lease.openedAt <= cutoff) {
                    closeLease(lease);
                    mount.leases.delete(id);
                }
            }
            if (mount.leases.size === 0 && mount.idleSince <= cutoff) {
                drop(key);
            }
        }
    };
    const mountFor = (key: string, conversationId: string | undefined): Mount => {
        const existing = mounts.get(key);
        if (existing !== undefined) {
            return existing;
        }
        const created: Mount = { token: randomBytes(32).toString("hex"), conversationId, leases: new Map(), idleSince: now() };
        mounts.set(key, created);
        keyOf.set(digestOf(created.token), key);
        return created;
    };
    return {
        lease: (conversationId) => {
            sweep();
            const key = conversationId === undefined ? `turn:${randomBytes(12).toString("hex")}` : `conversation:${conversationId}`;
            const leaseId = randomBytes(8).toString("hex");
            let held: Mount | undefined;
            let released = false;
            return {
                open: ({ name, target, timeoutMs }) => {
                    const tool = (token: string): AgentTool => ({
                        name,
                        url: `${deps.baseUrl()}/${encodeURIComponent(name)}`,
                        token,
                        ...(timeoutMs === undefined ? {} : { timeoutMs }),
                    });
                    if (released) {
                        // A mount after the turn ended reaches nothing: its target is closed at once, and no bearer minted.
                        closeTarget(target);
                        return tool(held?.token ?? "");
                    }
                    // Minted on the first mount, so a turn that mounts nothing leaves no bearer behind.
                    const mount = held ?? mountFor(key, conversationId);
                    held = mount;
                    let lease = mount.leases.get(leaseId);
                    if (lease === undefined) {
                        lease = { targets: new Map(), openedAt: now() };
                        mount.leases.set(leaseId, lease);
                    }
                    const replaced = lease.targets.get(name);
                    if (replaced !== undefined && replaced !== target) {
                        closeTarget(replaced);
                    }
                    lease.targets.set(name, target);
                    return tool(mount.token);
                },
                release: () => {
                    if (released) {
                        return;
                    }
                    released = true;
                    const mount = held;
                    const lease = mount?.leases.get(leaseId);
                    if (mount === undefined || lease === undefined) {
                        return;
                    }
                    closeLease(lease);
                    mount.leases.delete(leaseId);
                    if (mount.leases.size > 0) {
                        return;
                    }
                    mount.idleSince = now();
                    if (conversationId === undefined) {
                        drop(key);
                    }
                },
            };
        },
        resolve: (token, name) => {
            const key = token === undefined || token === "" ? undefined : keyOf.get(digestOf(token));
            const mount = key === undefined ? undefined : mounts.get(key);
            if (mount === undefined) {
                return { refused: "unknown" };
            }
            // Two turns of one conversation at once each hold their own; the later lease's server answers.
            let target: MountTarget | undefined;
            for (const lease of mount.leases.values()) {
                target = lease.targets.get(name) ?? target;
            }
            return target === undefined ? { refused: "unleased" } : { target, conversationId: mount.conversationId };
        },
        closeAll: () => {
            // Deleting the entry being visited is safe for a Map iterator.
            for (const key of mounts.keys()) {
                drop(key);
            }
            keyOf.clear();
        },
    };
};

// A turn's loop that releases its lease when it ends, however it ends: the mounts live in the daemon, so nothing else
// notices the turn is over and kills the browsers its routers started. Here, beside the lease, so a runtime's arm reaches
// it without importing the subsystems that mount things.
export const releasingMounts = <R>(loop: (request: R) => AsyncGenerator<AgentEvent>, held: Pick<TurnLease, "release">) =>
    async function* (request: R): AsyncGenerator<AgentEvent> {
        try {
            yield* loop(request);
        } finally {
            held.release();
        }
    };
