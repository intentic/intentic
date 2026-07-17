import {
    type AgentCapabilities,
    client,
    type ClientConnection,
    methods,
    PROTOCOL_VERSION,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AcpAgentConfig } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { decidePermission } from "./acp-permissions.js";
import { parseEnvBlock, spawnAcpProcess } from "./acp-spawn.js";

/* Pooled ACP connections, one warm subprocess per agent capability: spawned + initialized on first use, kept
 * across turns (ACP multiplexes sessions over one connection; cold-starting a Node/Rust agent per turn is
 * seconds of latency for nothing), reaped after idling, respawned lazily after an exit or a config change.
 * Turn-scoped behaviour (update routing, permission policy) binds per session id — the connection-level
 * handlers look the session up, so concurrent conversations on one agent never cross. */

// A dead connection is respawned on the next acquire; sessions it served die with it (session/load or the
// UI's session-not-found self-heal recovers).
const INIT_TIMEOUT_MS = 15_000;
const IDLE_REAP_MS = 15 * 60_000;

export const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

export interface TurnHooks {
    readonly onUpdate: (notification: SessionNotification) => void;
    readonly permission: (request: RequestPermissionRequest) => RequestPermissionResponse;
}

export interface AcpConnection {
    readonly agent: ClientConnection["agent"];
    readonly capabilities: AgentCapabilities;
    readonly alive: () => boolean;
    readonly stderrTail: () => string;
    // Session ids this PROCESS has served (created or loaded) — a resumed id absent here needs session/load.
    readonly sessions: Set<string>;
    // Route one session's updates/permissions to a turn; returns the unbind. Also marks the connection busy
    // (the idle reaper only fires with no bound turns).
    readonly bindTurn: (sessionId: string, hooks: TurnHooks) => () => void;
    readonly kill: () => void;
}

export interface AcpConnections {
    readonly acquire: (id: string, config: AcpAgentConfig, cwd: string) => Promise<AcpConnection>;
    // Kill + forget (capability removed). A live turn on it surfaces as an error frame — acceptable for an
    // explicit owner action.
    readonly drop: (id: string) => void;
}

interface Pooled {
    readonly configKey: string;
    readonly connection: AcpConnection;
}

export const createAcpConnections = (logger: Services["logger"]): AcpConnections => {
    const pool = new Map<string, Pooled>();

    const connect = async (id: string, config: AcpAgentConfig, cwd: string): Promise<AcpConnection> => {
        const proc = spawnAcpProcess(config.command, parseEnvBlock(config.env), cwd);
        const turns = new Map<string, TurnHooks>();
        const sessions = new Set<string>();
        let dead = false;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;

        const kill = (): void => {
            dead = true;
            clearTimeout(idleTimer);
            proc.child.kill();
            if (pool.get(id)?.connection === connection) {
                pool.delete(id);
            }
        };

        const armIdleReap = (): void => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                if (turns.size === 0) {
                    logger.info({ agent: id }, "acp: reaping idle connection");
                    kill();
                }
            }, IDLE_REAP_MS);
        };

        proc.child.on("exit", (code) => {
            dead = true;
            clearTimeout(idleTimer);
            if (pool.get(id)?.connection === connection) {
                pool.delete(id);
            }
            logger.info({ agent: id, code }, "acp: agent process exited");
        });

        const app = client({ name: "intentic" })
            .onRequest(methods.client.session.requestPermission, ({ params }) => {
                const hooks = turns.get(params.sessionId);
                // A request outside any bound turn (late arrival) gets the standing auto-allow policy.
                return hooks !== undefined ? hooks.permission(params) : decidePermission(params, "execute", false);
            })
            .onNotification(methods.client.session.update, ({ params }) => {
                turns.get(params.sessionId)?.onUpdate(params);
            });
        const conn = app.connect(proc.stream);

        // Guard initialize with a HARD timeout race — SDK request cancellation is cooperative, so a non-ACP
        // binary that never answers would otherwise hang the acquire forever.
        const init = await withTimeout(
            conn.agent.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                // fs is declined: the daemon has no unsaved editor buffers (disk is the source of truth),
                // so agents fall back to their own direct file access inside the container. terminal is
                // declined in phase 1 (the tmux panel mapping is the later upgrade).
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            }),
            INIT_TIMEOUT_MS,
        ).catch((error: unknown) => {
            kill();
            const reason = error instanceof Error ? error.message : "initialize failed";
            const detail = proc.stderrTail().trim();
            throw new Error(detail === "" ? `ACP initialize failed: ${reason}` : `ACP initialize failed: ${reason}: ${detail}`);
        });

        const connection: AcpConnection = {
            agent: conn.agent,
            capabilities: init.agentCapabilities ?? {},
            alive: () => !dead,
            stderrTail: proc.stderrTail,
            sessions,
            bindTurn: (sessionId, hooks) => {
                turns.set(sessionId, hooks);
                clearTimeout(idleTimer);
                return () => {
                    turns.delete(sessionId);
                    if (turns.size === 0 && !dead) {
                        armIdleReap();
                    }
                };
            },
            kill,
        };
        armIdleReap();
        return connection;
    };

    return {
        acquire: async (id, config, cwd) => {
            // Command/env changes take effect on the next turn: a stale pooled process is killed and respawned.
            const configKey = JSON.stringify([config.command, config.env ?? ""]);
            const pooled = pool.get(id);
            if (pooled !== undefined && pooled.connection.alive() && pooled.configKey === configKey) {
                return pooled.connection;
            }
            pooled?.connection.kill();
            const connection = await connect(id, config, cwd);
            pool.set(id, { configKey, connection });
            return connection;
        },
        drop: (id) => {
            pool.get(id)?.connection.kill();
        },
    };
};
