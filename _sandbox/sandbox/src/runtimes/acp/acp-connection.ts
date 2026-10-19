import { type AgentCapabilities, client, type ClientConnection, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { withTimeout } from "@intentic/base/async";
import type { Services } from "../../composition.js";
import type { TerminalRunner } from "../../terminal/terminal-run.js";
import type { SessionModels } from "./acp-model.js";
import type { SessionModes } from "./acp-modes.js";
import { routeSessions, type SessionRouting, type TurnHooks } from "./acp-routing.js";
import { createAcpTerminals } from "./acp-terminal.js";
import { type AcpLaunch, spawnAcpProcess } from "./acp-spawn.js";

// One warm subprocess per agent capability, kept across turns since ACP multiplexes sessions over one connection;
// reaped when idle, respawned after an exit or config change. Turn-scoped hooks bind per session id, so concurrent
// conversations on one agent never cross.

export type { TurnHooks } from "./acp-routing.js";

// A dead connection respawns on next acquire; its sessions die with it and recover via session/load.
const INIT_TIMEOUT_MS = 15_000;
const IDLE_REAP_MS = 15 * 60_000;

export interface AcpConnection {
    readonly agent: ClientConnection["agent"];
    readonly capabilities: AgentCapabilities;
    readonly alive: () => boolean;
    readonly stderrTail: () => string;
    // Session ids this process has served; one absent here needs session/load to resume.
    readonly sessions: Set<string>;
    // Each session's model option as the agent last stated it (acp-model.ts): set from what session/new, session/load
    // and session/set_config_option answer, and kept current by config_option_update. Absent: the agent offers none.
    readonly models: Map<string, SessionModels>;
    // Each session's reasoning-depth option (`thought_level`), kept the same way. Absent: the agent offers none.
    readonly thoughts: Map<string, SessionModels>;
    // Each session's modes (acp-modes.ts), from session/new and session/load, kept current by current_mode_update.
    readonly modes: Map<string, SessionModes>;
    // Routes one session's updates/permissions to a turn and returns the unbind; marks the connection busy.
    readonly bindTurn: (sessionId: string, hooks: TurnHooks) => () => void;
    // How a terminal this connection ran exited (acp-terminal.ts), for a tool call that embeds it and says no code.
    readonly terminalExit: (terminalId: string) => number | undefined;
    // Gives up on a session whose turn stopped answering, once that turn has cancelled and unbound it. The process is
    // every conversation's on this agent, so it is killed only when no other turn is bound to it; a process that hung
    // outright still dies once the last turn on it gives up. Until a turn binds the session again, a permission it asks
    // for is refused rather than auto-allowed: it was told to stop, and no turn is left to judge the ask.
    readonly abandon: (sessionId: string) => void;
    readonly kill: () => void;
}

export interface AcpConnections {
    readonly acquire: (id: string, launch: AcpLaunch, cwd: string) => Promise<AcpConnection>;
    // Kills and forgets the connection; a live turn on it then errors, acceptable for an explicit removal.
    readonly drop: (id: string) => void;
}

interface Pooled {
    readonly configKey: string;
    readonly connection: AcpConnection;
}

// The launch's sign-in, sent with the first method the agent advertises: the credential rides `_meta`, which is where an
// agent that takes a key over the protocol (Devin's `api_key`) reads it. An agent advertising none cannot be signed in.
const signIn = async (
    agent: AcpConnection["agent"],
    advertised: readonly { readonly id: string }[],
    meta: Readonly<Record<string, unknown>>,
): Promise<void> => {
    const method = advertised[0];
    if (method === undefined) {
        throw new Error("The agent offers no way to sign in over the protocol.");
    }
    await withTimeout(agent.request(methods.agent.authenticate, { methodId: method.id, _meta: { ...meta } }), INIT_TIMEOUT_MS);
};

export const createAcpConnections = (logger: Services["logger"], terminalRun: TerminalRunner): AcpConnections => {
    const pool = new Map<string, Pooled>();

    const connect = async (id: string, launch: AcpLaunch, cwd: string): Promise<AcpConnection> => {
        const proc = spawnAcpProcess(launch, cwd);
        const routing: SessionRouting = { turns: new Map(), abandoned: new Set(), models: new Map(), thoughts: new Map(), modes: new Map() };
        const { turns, abandoned } = routing;
        const terminals = createAcpTerminals(terminalRun);
        let dead = false;
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        // Set once initialize has answered; a process that dies or is killed before then was never pooled.
        let published: AcpConnection | undefined = undefined;

        const kill = (): void => {
            dead = true;
            clearTimeout(idleTimer);
            terminals.disposeAll();
            proc.child.kill();
            if (published !== undefined && pool.get(id)?.connection === published) {
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
            if (published !== undefined && pool.get(id)?.connection === published) {
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
        const app = routeSessions(client({ name: "intentic" }), routing)
            .onRequest(methods.client.terminal.create, async ({ params }) => {
                const context = terminalContext(params.sessionId);
                await context.admit(params);
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
                // exists. Form elicitation parks on the question card (acp-elicitation.ts); URL elicitation would send
                // a person off to a page no card can follow, so it is not offered.
                clientCapabilities: {
                    fs: { readTextFile: false, writeTextFile: false },
                    terminal: terminalRun.visible,
                    elicitation: { form: {} },
                },
            }),
            INIT_TIMEOUT_MS,
        ).catch((error: unknown) => {
            kill();
            const reason = error instanceof Error ? error.message : "initialize failed";
            const detail = proc.stderrTail().trim();
            throw new Error(detail === "" ? `ACP initialize failed: ${reason}` : `ACP initialize failed: ${reason}: ${detail}`);
        });
        if (launch.authenticate !== undefined) {
            await signIn(conn.agent, init.authMethods ?? [], launch.authenticate.meta).catch((error: unknown) => {
                kill();
                throw error;
            });
        }

        const connection: AcpConnection = {
            agent: conn.agent,
            capabilities: init.agentCapabilities ?? {},
            alive: () => !dead,
            stderrTail: proc.stderrTail,
            sessions: new Set<string>(),
            models: routing.models,
            thoughts: routing.thoughts,
            modes: routing.modes,
            terminalExit: terminals.exitCode,
            bindTurn: (sessionId, hooks) => {
                abandoned.delete(sessionId);
                turns.set(sessionId, hooks);
                clearTimeout(idleTimer);
                return () => {
                    if (turns.get(sessionId) !== hooks) {
                        return;
                    }
                    turns.delete(sessionId);
                    if (turns.size === 0 && !dead) {
                        armIdleReap();
                    }
                };
            },
            abandon: (sessionId) => {
                abandoned.add(sessionId);
                if (turns.size === 0) {
                    logger.info({ agent: id }, "acp: no turn left on a connection that stopped answering, ending it");
                    kill();
                }
            },
            kill,
        };
        published = connection;
        armIdleReap();
        return connection;
    };

    return {
        acquire: async (id, launch, cwd) => {
            // Command/env/credential changes take effect on the next turn: a stale pooled process is killed and respawned.
            const configKey = JSON.stringify([launch.argv, launch.env, launch.authenticate ?? null, launch.sessionMeta ?? null]);
            const pooled = pool.get(id);
            if (pooled !== undefined && pooled.connection.alive() && pooled.configKey === configKey) {
                return pooled.connection;
            }
            pooled?.connection.kill();
            const connection = await connect(id, launch, cwd);
            pool.set(id, { configKey, connection });
            return connection;
        },
        drop: (id) => {
            pool.get(id)?.connection.kill();
        },
    };
};
