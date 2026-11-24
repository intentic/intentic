import type { ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
    type AgentCapabilities,
    type AuthMethod,
    client,
    type ClientConnection,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    methods,
    ndJsonStream,
    PROTOCOL_VERSION,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import { CANCELLED } from "@intentic/acp-events/answers";
import { recordOptions, type SessionModels } from "@intentic/acp-events/model";
import { noteMode, type SessionModes } from "@intentic/acp-events/modes";
import { withTimeout } from "@intentic/base/async";
import { webStream } from "@intentic/base/web-stream";
import { z } from "zod";
import type { HarnessLaunch } from "./engines.js";
import type { PlaceHost } from "./place.js";

// ONE HARNESS PROCESS PER PLACE, kept across turns: the protocol carries many sessions over one connection, so every
// conversation on a harness in one place shares its process, and a session's traffic is handed to whichever turn is
// bound to it. Left idle it is ended after a quarter of an hour, and started again by the next turn. It never outlives
// this process: the desktop app's sidecar ends with the app, and its harnesses with it.

// What a turn hears of its session while it is bound to it.
export interface TurnHooks {
    readonly onUpdate: (notification: SessionNotification) => void;
    // The agent asking whether it may run something: answered by the reader, on a card.
    readonly permission: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
    // A form the agent asks the reader to fill: a question card.
    readonly elicit: (request: CreateElicitationRequest) => Promise<CreateElicitationResponse>;
}

export interface HarnessConnection {
    readonly agent: ClientConnection[`agent`];
    readonly capabilities: AgentCapabilities;
    // The ways the agent says it can be signed in, in its own order.
    readonly authMethods: readonly AuthMethod[];
    readonly launch: HarnessLaunch;
    readonly alive: () => boolean;
    readonly stderrTail: () => string;
    // Session ids this process has served; one absent here must be resumed before it is prompted.
    readonly sessions: Set<string>;
    readonly models: Map<string, SessionModels>;
    readonly thoughts: Map<string, SessionModels>;
    readonly modes: Map<string, SessionModes>;
    // Routes one session's traffic to a turn; the returned function lets go of it.
    readonly bindTurn: (sessionId: string, hooks: TurnHooks) => () => void;
    readonly kill: () => void;
}

const INIT_TIMEOUT_MS = 30_000;
const IDLE_REAP_MS = 15 * 60_000;
const STDERR_TAIL = 2_000;

const DECLINED: CreateElicitationResponse = { action: `decline` };
const SessionScopeSchema = z.object({ sessionId: z.string() });

const tailOf = (child: ChildProcess): (() => string) => {
    let tail = ``;
    child.stderr?.setEncoding(`utf8`);
    child.stderr?.on(`data`, (chunk: string) => {
        tail = (tail + chunk).slice(-STDERR_TAIL);
    });
    return () => tail;
};

const connect = async (host: PlaceHost, launch: HarnessLaunch, cwd: string, log: (line: string) => void, gone: (connection: HarnessConnection) => void): Promise<HarnessConnection> => {
    const child = await host.spawn(launch.argv, cwd, launch.env);
    const stderrTail = tailOf(child);
    const { stdin, stdout } = child;
    if (stdin === null || stdout === null) {
        child.kill();
        throw new Error(`The agent's process started without its pipes.`);
    }
    const turns = new Map<string, TurnHooks>();
    const models = new Map<string, SessionModels>();
    const thoughts = new Map<string, SessionModels>();
    const modes = new Map<string, SessionModes>();
    let dead = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = (): void => {
        dead = true;
        clearTimeout(idleTimer);
        child.kill();
    };
    const armIdleReap = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            if (turns.size === 0) {
                log(`ending an idle agent process (${launch.argv[0] ?? ``})`);
                kill();
            }
        }, IDLE_REAP_MS);
        idleTimer.unref();
    };
    // A program that could not be started at all says so here; the initialize below then fails on a closed stream.
    let startFailure: string | undefined;
    child.on(`error`, (error) => {
        startFailure = error.message;
        dead = true;
    });
    child.on(`exit`, (code) => {
        dead = true;
        clearTimeout(idleTimer);
        log(`agent process exited (${launch.argv[0] ?? ``}, code ${String(code)})`);
    });

    const app = client({ name: `intentic` })
        // First of every handler: an update the agent sent just before answering the prompt must land before the turn
        // reads the prompt as settled (the daemon's routing registers it first for the same reason).
        .onNotification(methods.client.session.update, ({ params }) => {
            if (params.update.sessionUpdate === `config_option_update`) {
                recordOptions({ models, thoughts }, params.sessionId, params.update.configOptions);
            }
            if (params.update.sessionUpdate === `current_mode_update`) {
                noteMode(modes, params.sessionId, params.update.currentModeId);
            }
            turns.get(params.sessionId)?.onUpdate(params);
        })
        // With no turn bound, nobody is there to ask: the call is not run.
        .onRequest(methods.client.session.requestPermission, ({ params }) => turns.get(params.sessionId)?.permission(params) ?? CANCELLED)
        .onRequest(methods.client.elicitation.create, ({ params }) => {
            const scope = SessionScopeSchema.safeParse(params);
            const hooks = scope.success ? turns.get(scope.data.sessionId) : undefined;
            return hooks === undefined ? DECLINED : hooks.elicit(params);
        });
    const conn = app.connect(ndJsonStream(Writable.toWeb(stdin), webStream<Uint8Array>(Readable.toWeb(stdout))));

    const init = await withTimeout(
        conn.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            // No file or terminal methods: the agent reads, writes and runs on this computer itself, as it does in the
            // reader's own terminal. `auth.terminal` lets an agent whose sign-in is a command of its own name it.
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
                elicitation: { form: {} },
                auth: { terminal: true },
            },
        }),
        INIT_TIMEOUT_MS,
    ).catch((error: Error) => {
        kill();
        const reason = startFailure ?? error.message;
        const detail = stderrTail().trim();
        throw new Error(detail === `` ? `The agent did not start: ${reason}` : `The agent did not start: ${reason}: ${detail}`);
    });

    const connection: HarnessConnection = {
        agent: conn.agent,
        capabilities: init.agentCapabilities ?? {},
        authMethods: init.authMethods ?? [],
        launch,
        alive: () => !dead,
        stderrTail,
        sessions: new Set<string>(),
        models,
        thoughts,
        modes,
        bindTurn: (sessionId, hooks) => {
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
        kill,
    };
    // Heard only once initialize has answered: a process that dies before then was never handed to anyone.
    child.on(`exit`, () => gone(connection));
    armIdleReap();
    return connection;
};

export interface HarnessConnections {
    // The live process for `key`, or a new one started in `cwd`. A launch that changed since (the harness was fetched,
    // or installed elsewhere) replaces the process once nothing is bound to the old one's start.
    readonly acquire: (key: string, host: PlaceHost, launch: HarnessLaunch, cwd: string) => Promise<HarnessConnection>;
    // Ends the process for `key`, so the next turn starts one afresh: after a sign-in, which a running process may not see.
    readonly drop: (key: string) => void;
    readonly closeAll: () => void;
}

export const createHarnessConnections = (log: (line: string) => void): HarnessConnections => {
    const pool = new Map<string, { readonly launchKey: string; readonly connection: Promise<HarnessConnection> }>();
    return {
        acquire: async (key, host, launch, cwd) => {
            const launchKey = JSON.stringify([launch.argv, launch.env]);
            const pooled = pool.get(key);
            if (pooled !== undefined && pooled.launchKey === launchKey) {
                // allow(silent-catch): a start that failed is retried below, and its error is that retry's to report
                const live = await pooled.connection.catch(() => undefined);
                if (live?.alive() === true) {
                    return live;
                }
            }
            const connection = connect(host, launch, cwd, log, (ended) => {
                void pool.get(key)?.connection.then(
                    (current) => {
                        if (current === ended) {
                            pool.delete(key);
                        }
                    },
                    () => undefined,
                );
            });
            pool.set(key, { launchKey, connection });
            return connection;
        },
        drop: (key) => {
            const pooled = pool.get(key);
            pool.delete(key);
            void pooled?.connection.then(
                (connection) => connection.kill(),
                () => undefined,
            );
        },
        closeAll: () => {
            for (const [key, pooled] of pool) {
                pool.delete(key);
                void pooled.connection.then(
                    (connection) => connection.kill(),
                    () => undefined,
                );
            }
        },
    };
};
