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
import type { Services } from "../../composition.js";
import type { TerminalRunner } from "../../terminal/terminal-run.js";
import { decidePermission } from "./acp-permissions.js";
import { createAcpTerminals } from "./acp-terminal.js";
import { parseEnvBlock, spawnAcpProcess } from "./acp-spawn.js";

// One warm subprocess per agent capability, kept across turns since ACP multiplexes sessions over one connection;
// reaped when idle, respawned after an exit or config change. Turn-scoped hooks bind per session id, so concurrent
// conversations on one agent never cross.

// A dead connection respawns on next acquire; its sessions die with it and recover via session/load.
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
    // Can park: the owner's rulebook may hold this call for approval while the agent waits on the response.
    readonly permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
    // Turn's tmux session, cwd and first-create signal for terminal requests; absent refuses them.
    readonly terminal?: {
        readonly session: string;
        readonly cwd: string;
        readonly onCreate: () => void;
    };
}

export interface AcpConnection {
    readonly agent: ClientConnection["agent"];
    readonly capabilities: AgentCapabilities;
    readonly alive: () => boolean;
    readonly stderrTail: () => string;
    // Session ids this process has served; one absent here needs session/load to resume.
    readonly sessions: Set<string>;
    // Routes one session's updates/permissions to a turn and returns the unbind; marks the connection busy.
    readonly bindTurn: (sessionId: string, hooks: TurnHooks) => () => void;
    readonly kill: () => void;
}

export interface AcpConnections {
    readonly acquire: (id: string, config: AcpAgentConfig, cwd: string) => Promise<AcpConnection>;
    // Kills and forgets the connection; a live turn on it then errors, acceptable for an explicit removal.
    readonly drop: (id: string) => void;
}

interface Pooled {
    readonly configKey: string;
    readonly connection: AcpConnection;
}

export const createAcpConnections = (logger: Services["logger"], terminalRun: TerminalRunner): AcpConnections => {
    const pool = new Map<string, Pooled>();

    const connect = async (id: string, config: AcpAgentConfig, cwd: string): Promise<AcpConnection> => {
        const proc = spawnAcpProcess(config.command, parseEnvBlock(config.env), cwd);
        const turns = new Map<string, TurnHooks>();
        const sessions = new Set<string>();
        const terminals = createAcpTerminals(terminalRun);
        let dead = false;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;

        const kill = (): void => {
            dead = true;
            clearTimeout(idleTimer);
            terminals.disposeAll();
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

        // Resolves a turn's tmux context by session id; refused if the session has no bound turn.
        const terminalContext = (sessionId: string): NonNullable<TurnHooks["terminal"]> => {
            const context = turns.get(sessionId)?.terminal;
            if (context === undefined) {
                throw new Error("no terminal is available for this session");
            }
            return context;
        };
        const app = client({ name: "intentic" })
            .onRequest(methods.client.session.requestPermission, ({ params }) => {
                const hooks = turns.get(params.sessionId);
                // A late request with no bound turn falls back to the standing auto-allow policy.
                return hooks !== undefined ? hooks.permission(params) : decidePermission(params, "execute", false);
            })
            .onNotification(methods.client.session.update, ({ params }) => {
                turns.get(params.sessionId)?.onUpdate(params);
            })
            .onRequest(methods.client.terminal.create, ({ params }) => {
                const context = terminalContext(params.sessionId);
                context.onCreate();
                return { terminalId: terminals.create(context.session, context.cwd, params) };
            })
            .onRequest(methods.client.terminal.output, ({ params }) => {
                const response = terminals.output(params.terminalId);
                if (response === undefined) {
                    throw new Error(`unknown terminal ${params.terminalId}`);
                }
                return response;
            })
            .onRequest(methods.client.terminal.waitForExit, ({ params }) => {
                const exit = terminals.waitForExit(params.terminalId);
                if (exit === undefined) {
                    throw new Error(`unknown terminal ${params.terminalId}`);
                }
                return exit;
            })
            .onRequest(methods.client.terminal.kill, ({ params }) => {
                if (!terminals.kill(params.terminalId)) {
                    throw new Error(`unknown terminal ${params.terminalId}`);
                }
                return {};
            })
            .onRequest(methods.client.terminal.release, ({ params }) => {
                terminals.release(params.terminalId);
                return {};
            });
        const conn = app.connect(proc.stream);

        // Hard timeout: SDK cancellation is cooperative, so a non-answering binary would otherwise hang forever.
        const init = await withTimeout(
            conn.agent.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                // fs declined: no unsaved editor buffers here. terminal is advertised only where the tmux wrapper
                // exists.
                clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: terminalRun.visible },
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
