import { type AgentCapabilities, client, type ClientApp, type ClientConnection, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk/unstable";
import { withTimeout } from "@intentic/base/async";
import { z } from "zod";
import { opt } from "../../opt.js";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Services } from "../../composition.js";
import type { TerminalRunner } from "../../terminal/terminal-run.js";
import type { SessionModels } from "@intentic/acp-events/model";
import type { SessionModes } from "@intentic/acp-events/modes";
import { type AcpDialect, type ChildStop, type DialectReader, dialectOf, type Json, plainReader } from "@intentic/acp-events/dialects";
import { routeSessions, type SessionRouting, type TurnHooks } from "./acp-routing.js";
import { type AcpTerminals, createAcpTerminals } from "./acp-terminal.js";
import { type AcpLaunch, spawnAcpProcess, stopAcpProcess } from "./acp-spawn.js";

// One warm subprocess per agent capability, kept across turns since ACP multiplexes sessions over one connection;
// reaped when idle, respawned after an exit or config change. Turn-scoped hooks bind per session id, so concurrent
// conversations on one agent never cross. Warm only while a conversation's session is open on it: a process that served
// nothing but model probes and helpers' one-shot sessions ends a short grace after the last of them lets go.

export type { TurnHooks } from "./acp-routing.js";

// A dead connection respawns on next acquire; its sessions die with it and recover via session/load.
const INIT_TIMEOUT_MS = 15_000;
const IDLE_REAP_MS = 15 * 60_000;
// How long a process nothing holds outlives the probe or helper it last served: long enough for the burst of model lists
// and helpers one opened composer asks for to share it. 2026-11-26, rog short of memory: two `devin acp` processes (~155 MB
// each) sat out their whole 15-minute reap after a composer open, one from the model probe, one from a helper, with no
// Devin conversation in the sandbox.
const UNHELD_GRACE_MS = 30_000;

// How long an idle process lives: `idleMs` while a conversation's session is open on it, `unheldMs` when none is.
export interface AcpReapTimes {
    readonly idleMs: number;
    readonly unheldMs: number;
}

export interface AcpConnection {
    readonly agent: ClientConnection["agent"];
    readonly capabilities: AgentCapabilities;
    readonly alive: () => boolean;
    readonly stderrTail: () => string;
    // Session ids this process has served; one absent here needs session/load to resume.
    readonly sessions: Set<string>;
    // Each session's model option as the agent last stated it (acp-events model.ts): set from what session/new, session/load
    // and session/set_config_option answer, and kept current by config_option_update. Absent: the agent offers none.
    readonly models: Map<string, SessionModels>;
    // Each session's reasoning-depth option (`thought_level`), kept the same way. Absent: the agent offers none.
    readonly thoughts: Map<string, SessionModels>;
    // Each session's modes (acp-events modes.ts), from session/new and session/load, kept current by current_mode_update.
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
    // Ends a session nobody will resume (a sealed request's, a model probe's) and forgets what was recorded of it. An
    // agent keeps every session it opened live until it is told otherwise: Devin's CLI re-scans each one's skills every
    // 15 s, so a helper's sessions left open made an idle process busier by the hour and held its idle reap off.
    readonly release: (sessionId: string) => void;
    // Ends one `acquire`'s use, once its caller is done with the process (a turn's end, a probe's answer). While any use
    // is open the process is never ended early; once none is, no turn is bound and no conversation's session is open on
    // it, it ends after the short grace. A use never let go only leaves it to the idle reap, as before.
    readonly letGo: () => void;
    readonly kill: () => void;
    // What the agent says beyond the protocol (AcpLaunch.dialect), and this process's reading of it: which subagents and
    // background tasks each session has running, and whether the agent owes a session a wake-up of its own.
    readonly dialect: AcpDialect | undefined;
    readonly reader: DialectReader;
    // Ends what a session still has running through the dialect's own stop methods, each probed once per process first
    // with params that name no child, so an agent without one is never sent a stop it cannot read.
    readonly stopChildren: (sessionId: string) => void;
}

export interface AcpConnections {
    // The agent's process, one per id whatever the cwd (the cwd only places a process this call starts; each session
    // names its own), started when none is live or its launch changed. Each call is a use its caller ends with `letGo`.
    readonly acquire: (id: string, launch: AcpLaunch, cwd: string) => Promise<AcpConnection>;
    // Kills and forgets the connection; a live turn on it then errors, acceptable for an explicit removal.
    readonly drop: (id: string) => void;
}

interface Pooled {
    readonly configKey: string;
    readonly connection: AcpConnection;
    // Opens one use of the connection (AcpConnection.letGo ends it).
    readonly enter: () => void;
}

// The method that ends a session in the agent, preferring `delete` (gone from its list too) over `close`; undefined when
// the agent advertises neither, and its sessions then live as long as its process.
const endMethod = (capabilities: AgentCapabilities) =>
    capabilities.sessionCapabilities?.delete != null
        ? methods.agent.session.delete
        : capabilities.sessionCapabilities?.close != null
          ? methods.agent.session.close
          : undefined;

// What `release` does, shared with the in-process fixture: forget the session's recorded state, then end it in the agent.
// A refusal is only said: a session that never ends costs idle CPU, not correctness.
export const releaseSession = (
    connection: Pick<AcpConnection, "agent" | "capabilities" | "alive" | "sessions" | "models" | "thoughts" | "modes">,
    sessionId: string,
    refused: (reason: string) => void,
): void => {
    connection.sessions.delete(sessionId);
    connection.models.delete(sessionId);
    connection.thoughts.delete(sessionId);
    connection.modes.delete(sessionId);
    const method = endMethod(connection.capabilities);
    if (method !== undefined && connection.alive()) {
        connection.agent.request(method, { sessionId }).then(
            () => undefined,
            (error: Error) => refused(error.message),
        );
    }
};

// One short job on an acquired connection (a model probe), its use let go however the job ends, so a process nothing
// else holds ends after the short grace rather than the idle reap.
export const withConnection = async <T>(acquired: Promise<AcpConnection>, job: (connection: AcpConnection) => Promise<T>): Promise<T> => {
    const connection = await acquired;
    try {
        return await job(connection);
    } finally {
        connection.letGo();
    }
};

// A turn's events passed through, with the session they opened released (`AcpConnection.release`) once they end or are
// stopped: for a turn whose session nobody resumes.
export async function* releasingSession(connection: Pick<AcpConnection, "release">, events: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
    let opened: string | undefined;
    try {
        for await (const event of events) {
            opened = event.kind === "session" ? event.sessionId : opened;
            yield event;
        }
    } finally {
        if (opened !== undefined) {
            connection.release(opened);
        }
    }
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

// The client's terminal methods, run in the bound turn's tmux session (acp-terminal.ts).
const serveTerminals = (app: ClientApp, terminals: AcpTerminals, terminalContext: (sessionId: string) => NonNullable<TurnHooks["terminal"]>): ClientApp =>
    app
        .onRequest(methods.client.terminal.create, async ({ params }) => {
            const context = terminalContext(params.sessionId);
            const prepared = await context.admit(params);
            context.onCreate();
            return { terminalId: terminals.create(context.session, context.cwd, params, prepared) };
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

// JSON-RPC's own error shape, as a refused request rejects with it.
const RefusalSchema = z.object({ code: z.number(), data: z.json().optional() });

// What `stopChildren` does, shared with the in-process fixture. A probe or a stop the agent refuses is only said: the
// child then runs on, as it would have without a stop to send.
export const childStopper = (
    connection: Pick<AcpConnection, "agent" | "alive" | "dialect" | "reader">,
    refused: (reason: string) => void,
): ((sessionId: string) => void) => {
    const probes = new Map<ChildStop, Promise<boolean>>();
    const supported = (stop: ChildStop): Promise<boolean> => {
        const known = probes.get(stop);
        if (known !== undefined) {
            return known;
        }
        const probed = connection.agent.request<Json>(stop.method, stop.probe).then(
            (result) => stop.supported({ result }),
            (error: Error) => {
                const parsed = RefusalSchema.safeParse(error);
                return parsed.success && stop.supported({ error: { code: parsed.data.code, ...opt("data", parsed.data.data) } });
            },
        );
        probes.set(stop, probed);
        return probed;
    };
    const send = async (stop: ChildStop | undefined, sessionId: string, ids: readonly string[]): Promise<void> => {
        if (stop === undefined || ids.length === 0 || !(await supported(stop))) {
            return;
        }
        await Promise.all(ids.map((id) => connection.agent.request(stop.method, stop.params(sessionId, id))));
    };
    return (sessionId) => {
        const live = connection.reader.live(sessionId);
        if (!connection.alive() || connection.dialect === undefined) {
            return;
        }
        void Promise.all([send(connection.dialect.subagentStop, sessionId, live.subagents), send(connection.dialect.taskStop, sessionId, live.tasks)]).catch(
            (error: Error) => refused(error.message),
        );
    };
};

type ReapKind = "idle" | "unheld";

// The countdown that ends an idle process. `idle` while something may come back to it: a conversation's session open on
// it, or an acquire not yet let go. `unheld` once nothing is: no turn, no use, and no session but the ones a probe or a
// helper released as it answered. A bound turn stops the count; something letting go never lengthens it, so a probe on
// a conversation's process does not push that process's idle reap back.
const createReaper = (
    times: AcpReapTimes,
    holds: { readonly turns: () => number; readonly sessions: () => number },
    end: (kind: ReapKind) => void,
) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let armed: ReapKind | undefined;
    let uses = 0;
    let stopped = false;
    const arm = (kind: ReapKind): void => {
        clearTimeout(timer);
        armed = kind;
        timer = setTimeout(
            () => {
                armed = undefined;
                if (holds.turns() === 0) {
                    end(kind);
                }
            },
            kind === "idle" ? times.idleMs : times.unheldMs,
        );
    };
    const unheld = (): boolean => holds.turns() === 0 && uses === 0 && holds.sessions() === 0;
    const settle = (): void => {
        if (!stopped && unheld()) {
            arm("unheld");
        }
    };
    return {
        start: () => arm("idle"),
        // A use swaps the unheld grace for the idle count, so a turn still opening its session on a process a probe just
        // let go of is not ended under it.
        enter: (): void => {
            uses += 1;
            if (!stopped && holds.turns() === 0 && armed !== "idle") {
                arm("idle");
            }
        },
        letGo: (): void => {
            uses = Math.max(0, uses - 1);
            settle();
        },
        settle,
        bound: (): void => {
            armed = undefined;
            clearTimeout(timer);
        },
        unbound: (): void => {
            if (!stopped && holds.turns() === 0) {
                arm(unheld() ? "unheld" : "idle");
            }
        },
        stop: (): void => {
            stopped = true;
            armed = undefined;
            clearTimeout(timer);
        },
    };
};

interface PoolDeps {
    readonly logger: Services["logger"];
    readonly terminalRun: TerminalRunner;
    readonly reapAfter: AcpReapTimes;
    readonly pool: Map<string, Pooled>;
}

const connect = async (
    { logger, terminalRun, reapAfter, pool }: PoolDeps,
    id: string,
    launch: AcpLaunch,
    cwd: string,
    configKey: string,
): Promise<Pooled> => {
    const proc = spawnAcpProcess(launch, cwd);
    const dialect = dialectOf(launch.dialect);
    const reader = dialect?.reader() ?? plainReader();
    const routing: SessionRouting = {
        turns: new Map(),
        abandoned: new Set(),
        models: new Map(),
        thoughts: new Map(),
        modes: new Map(),
        ...opt("dialect", dialect === undefined ? undefined : { speaks: dialect, reader }),
    };
    const { turns, abandoned } = routing;
    const terminals = createAcpTerminals(terminalRun);
    let dead = false;
    const sessions = new Set<string>();
    // Set once initialize has answered; a process that dies or is killed before then was never pooled.
    let published: AcpConnection | undefined = undefined;
    const reaper = createReaper(reapAfter, { turns: () => turns.size, sessions: () => sessions.size }, (kind) => {
        logger.info({ agent: id }, kind === "idle" ? "acp: reaping idle connection" : "acp: ending a process no conversation holds");
        kill();
    });

    const kill = (): void => {
        dead = true;
        reaper.stop();
        terminals.disposeAll();
        stopAcpProcess(proc);
        if (published !== undefined && pool.get(id)?.connection === published) {
            pool.delete(id);
        }
    };

    proc.child.on("exit", (code) => {
        dead = true;
        // A leader that exited on its own leaves its children in its group; stamped as the daemon's, nothing else
        // would ever end them.
        stopAcpProcess(proc);
        reaper.stop();
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
    const app = serveTerminals(routeSessions(client({ name: "intentic" }), routing), terminals, terminalContext);
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
        sessions,
        models: routing.models,
        thoughts: routing.thoughts,
        modes: routing.modes,
        terminalExit: terminals.exitCode,
        bindTurn: (sessionId, hooks) => {
            abandoned.delete(sessionId);
            turns.set(sessionId, hooks);
            reaper.bound();
            return () => {
                if (turns.get(sessionId) !== hooks) {
                    return;
                }
                turns.delete(sessionId);
                reaper.unbound();
            };
        },
        abandon: (sessionId) => {
            abandoned.add(sessionId);
            if (turns.size === 0) {
                logger.info({ agent: id }, "acp: no turn left on a connection that stopped answering, ending it");
                kill();
            }
        },
        release: (sessionId) => {
            releaseSession(connection, sessionId, (reason) => logger.warn({ agent: id, reason }, "acp: could not end a session nobody resumes"));
            reaper.settle();
        },
        letGo: reaper.letGo,
        kill,
        dialect,
        reader,
        stopChildren: (sessionId) => stopChildren(sessionId),
    };
    const stopChildren = childStopper(connection, (reason) => logger.warn({ agent: id, reason }, "acp: the agent refused to stop a child of a stopped turn"));
    published = connection;
    reaper.start();
    return { configKey, connection, enter: reaper.enter };
};

export const createAcpConnections = (
    logger: Services["logger"],
    terminalRun: TerminalRunner,
    reapAfter: AcpReapTimes = { idleMs: IDLE_REAP_MS, unheldMs: UNHELD_GRACE_MS },
): AcpConnections => {
    const pool = new Map<string, Pooled>();
    const deps: PoolDeps = { logger, terminalRun, reapAfter, pool };
    // A start still answering initialize, so a probe and a turn asking for one agent at once share one process rather
    // than each spawning its own, the earlier left out of the pool to sit out its reap.
    const starting = new Map<string, { readonly configKey: string; readonly pooled: Promise<Pooled> }>();

    const startOnce = (id: string, launch: AcpLaunch, cwd: string, configKey: string): Promise<Pooled> => {
        const pending = starting.get(id);
        if (pending !== undefined && pending.configKey === configKey) {
            return pending.pooled;
        }
        const pooled = connect(deps, id, launch, cwd, configKey).then((started) => {
            pool.set(id, started);
            return started;
        });
        starting.set(id, { configKey, pooled });
        const done = (): void => {
            if (starting.get(id)?.pooled === pooled) {
                starting.delete(id);
            }
        };
        pooled.then(done, done);
        return pooled;
    };

    return {
        acquire: async (id, launch, cwd) => {
            // Command/env/credential changes take effect on the next turn: a stale pooled process is killed and respawned.
            const configKey = JSON.stringify([launch.argv, launch.env, launch.authenticate ?? null, launch.sessionMeta ?? null, launch.dialect ?? null]);
            const pooled = pool.get(id);
            if (pooled !== undefined && pooled.connection.alive() && pooled.configKey === configKey) {
                pooled.enter();
                return pooled.connection;
            }
            pooled?.connection.kill();
            const started = await startOnce(id, launch, cwd, configKey);
            started.enter();
            return started.connection;
        },
        drop: (id) => {
            pool.get(id)?.connection.kill();
        },
    };
};
