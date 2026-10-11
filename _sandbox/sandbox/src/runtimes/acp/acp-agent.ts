import { type ContentBlock, type McpServer, methods, type PromptResponse, RequestError, type SessionNotification } from "@agentclientprotocol/sdk";
import { ACP, type AgentEvent } from "@intentic/sandbox-contract";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { whenAborted } from "@intentic/base/async";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import { imageBlock } from "../../agent/prompt/attachment-images.js";
import type { PlanPhaseResult } from "../decorators/plan-mode.js";
import {
    DEFAULT_TURN_TIMEOUTS,
    EXPIRED,
    idleWait,
    type IdleWait,
    SETTLED,
    type TurnTimeouts,
    type TurnWatchdog,
    turnWatchdog,
    watchedPull,
} from "../decorators/turn-watchdog.js";
import { withStderrTail } from "../decorators/vendor-errors.js";
import { textPlanTurn, vendorTurn } from "../decorators/vendor-turn.js";
import type { AcpConnection, AcpConnections } from "./acp-connection.js";
import type { AcpLaunch } from "./acp-spawn.js";
import { sessionUpdateEvent } from "./acp-events.js";
import { recordModels } from "./acp-model.js";
import { decidePermission, type PermissionPhase } from "./acp-permissions.js";

// The ACP provider adapter, the seam runAgent/createCodexAgent/createOpenCodeAgent share: AgentRequest in, AgentEvent out,
// over any agent speaking the Agent Client Protocol. One warm connection per agent, one session per conversation. A
// documented floor, not the native ceiling: an installed agent owns its model settings, MCP tools pass through only when
// advertised. A native provider on this runtime (Devin) names the model through AcpTurnOptions.

// What a provider built on this runtime decides per turn beyond the request. An installed agent card decides none of it.
export interface AcpTurnOptions {
    // A value the session's model option offers (acp-model.ts): the session is switched to it before the prompt and the
    // turn announces it. Absent, the agent keeps its own pick and nothing is announced.
    readonly model?: string | undefined;
}

// A model the session's own option does not offer: the account's list moved since the catalog last read it.
class ModelNotOffered extends Error {}

// The agent's MCP servers: the turn's remote list (every mount at the daemon's MCP door, browsers included, and the
// mcp-kind cards) passes through when the agent advertises http MCP support; in-process SDK servers have no ACP
// projection (accepted loss for ACP turns).
const mcpServersOf = (request: AgentRequest, connection: AcpConnection): McpServer[] => {
    if (connection.capabilities.mcpCapabilities?.http !== true) {
        return [];
    }
    return (request.tools.remote ?? []).map((tool) => ({
        type: "http",
        name: tool.name,
        url: tool.url,
        headers: tool.token !== undefined ? [{ name: "Authorization", value: `Bearer ${tool.token}` }] : [],
    }));
};

// The SDK wraps a throwing handler as "Internal error"; the real reason lives in data.details, unwrapped here.
const failureOf = (error: unknown): string => {
    const details = (error as { data?: { details?: unknown } }).data?.details;
    return typeof details === "string" && details !== "" ? details : error instanceof Error ? error.message : "ACP agent failed";
};

// ACP credentials belong to the capability, not a native provider account's reconnect flow.
const authCodeOf = (error: RequestError | undefined): Pick<Extract<AgentEvent, { kind: "error" }>, "code"> =>
    error?.code === RequestError.authRequired().code ? { code: "acp-auth-required" } : {};

// The session a phase runs on: the one asked for when this process holds it or can load it, else a new one, announced. A
// session the agent can't bring back is the coded self-heal every runtime shares: the next send starts fresh.
async function* sessionFor(
    connection: AcpConnection,
    request: AgentRequest,
    sessionId: string | undefined,
): AsyncGenerator<AgentEvent, string | undefined> {
    if (sessionId !== undefined && connection.sessions.has(sessionId)) {
        return sessionId;
    }
    if (sessionId !== undefined) {
        // A fresh process doesn't know this session; session/load's replay arrives unbound, so it's dropped.
        if (connection.capabilities.loadSession !== true) {
            yield {
                kind: "error",
                code: "session-not-found",
                message: "The agent restarted and cannot resume this chat's session. Send again to start fresh.",
            };
            return undefined;
        }
        // Only an explicit missing resource retires the session; authentication and replay failures may recover.
        const refused = await connection.agent
            .request(methods.agent.session.load, {
                sessionId,
                cwd: request.spec.cwd,
                mcpServers: mcpServersOf(request, connection),
            })
            .then(
                (loaded) => {
                    recordModels(connection.models, sessionId, loaded.configOptions);
                    return false;
                },
                (error: unknown) => {
                    if (error instanceof RequestError && error.code === RequestError.resourceNotFound().code) {
                        return true;
                    }
                    throw error;
                },
            );
        if (refused) {
            yield { kind: "error", code: "session-not-found", message: "The agent no longer has this chat's session. Send again to start fresh." };
            return undefined;
        }
        connection.sessions.add(sessionId);
        return sessionId;
    }
    const created = await connection.agent.request(methods.agent.session.new, {
        cwd: request.spec.cwd,
        mcpServers: mcpServersOf(request, connection),
    });
    recordModels(connection.models, created.sessionId, created.configOptions);
    connection.sessions.add(created.sessionId);
    yield { kind: "session", sessionId: created.sessionId };
    return created.sessionId;
}

// Puts the session on the model asked for and answers what it now runs on. Undefined when the agent offers no model
// option for this session: it keeps its own, as an installed agent does. Asking for one it does not offer throws
// ModelNotOffered rather than running the turn on a model nobody picked.
const settleModel = async (connection: AcpConnection, sessionId: string, wanted: string): Promise<string | undefined> => {
    const models = connection.models.get(sessionId);
    if (models === undefined || models.current === wanted) {
        return models?.current;
    }
    if (!models.choices.some((choice) => choice.value === wanted)) {
        const offered = models.choices.map((choice) => choice.name).join(", ");
        throw new ModelNotOffered(
            `${wanted} is not one of the models this account offers${offered === "" ? "" : ` (${offered})`}. Pick another model.`,
        );
    }
    const answer = await connection.agent.request(methods.agent.session.setConfigOption, { sessionId, configId: models.configId, value: wanted });
    return recordModels(connection.models, sessionId, answer.configOptions)?.current ?? wanted;
};

// A phase's live half: what the agent sends lands in `queue` (or, while planning, in `text`), and every landing wakes
// the loop. The gate's sink is repointed here, since the gate outlives a phase and the queue does not. `clock` is the
// phase's watchdog, held while a permission is decided: the agent is waiting on the daemon then, and a card open on a
// person is not a stalled agent.
const bindPhase = (
    connection: AcpConnection,
    request: AgentRequest,
    session: string,
    turn: {
        readonly phase: PermissionPhase;
        readonly captureText: boolean;
        readonly gate: CommandGuard;
        readonly sink: { push: (event: AgentEvent) => void };
    },
    wait: IdleWait,
    clock: Pick<TurnWatchdog, "hold">,
) => {
    const queue: AgentEvent[] = [];
    const held = { text: "" };
    turn.sink.push = (event) => {
        queue.push(event);
        wait.wake();
    };
    const onUpdate = (notification: SessionNotification): void => {
        const update = notification.update;
        if (turn.captureText && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            // Plan phase: the agent's answer is the plan, held back rather than streamed as deltas.
            held.text += update.content.text;
            wait.wake();
            return;
        }
        const event = sessionUpdateEvent(update, request.spec.cwd);
        if (event !== undefined) {
            queue.push(event);
        }
        wait.wake();
    };
    // terminal/create runs in the conversation's own tmux session; the first one surfaces it in the panel.
    const tmuxSession = agentSessionName(session);
    let terminalSurfaced = false;
    const unbind = connection.bindTurn(session, {
        onUpdate,
        permission: async (permissionRequest) => {
            const release = clock.hold();
            try {
                return await decidePermission(permissionRequest, turn.phase, request.signal.aborted, turn.gate, (event) => turn.sink.push(event));
            } finally {
                release();
            }
        },
        ...(tmuxSession !== undefined
            ? {
                  terminal: {
                      session: tmuxSession,
                      cwd: request.spec.cwd,
                      onCreate: () => {
                          if (!terminalSurfaced) {
                              terminalSurfaced = true;
                              queue.push({ kind: "terminal", session: tmuxSession });
                              wait.wake();
                          }
                      },
                  },
              }
            : {}),
    });
    return { queue, held, unbind };
};

// What the prompt's own answer says once it settles: a thrown failure, or a stop reason the agent gave up on. End_turn
// or a cancel is a normal finish; a cancel surfaces nothing extra, the user stopped it.
const settledFailure = (response: PromptResponse | undefined, failure: unknown, stderrTail: () => string): string | undefined => {
    if (failure !== undefined) {
        return withStderrTail(failureOf(failure), stderrTail());
    }
    const stopReason = response?.stopReason;
    if (stopReason === "refusal") {
        return "The agent refused this request.";
    }
    return stopReason === "max_tokens" || stopReason === "max_turn_requests" ? `The agent stopped early (${stopReason}).` : undefined;
};

// One prompt turn on one session: resolves/creates/loads it, binds routing, and streams mapped updates until the
// response settles or the watchdog fires. Never emits the terminal `done`; callers do once the whole turn settles.
async function* runAcpTurn(
    connection: AcpConnection,
    request: AgentRequest,
    prompt: ContentBlock[],
    sessionId: string | undefined,
    turn: {
        readonly phase: PermissionPhase;
        readonly captureText: boolean;
        readonly timeouts: TurnTimeouts;
        // This turn's rulebook gate; one gate for the whole turn, its sink repointed per phase rather than rebuilt.
        readonly gate: CommandGuard;
        readonly sink: { push: (event: AgentEvent) => void };
        // The turn's model, settled before every phase's prompt and announced once (`announced` outlives the phase).
        readonly model: { readonly wanted: string | undefined; announced: boolean };
    },
): AsyncGenerator<AgentEvent, PlanPhaseResult> {
    let session: string | undefined;
    let running: string | undefined;
    try {
        session = yield* sessionFor(connection, request, sessionId);
        running = session !== undefined && turn.model.wanted !== undefined ? await settleModel(connection, session, turn.model.wanted) : undefined;
    } catch (error) {
        if (error instanceof ModelNotOffered) {
            yield { kind: "error", code: "model-unavailable", message: error.message };
            return { sessionId: session, planText: "", errored: true };
        }
        yield { kind: "error", message: withStderrTail(failureOf(error), connection.stderrTail()), ...authCodeOf(error instanceof RequestError ? error : undefined) };
        return { sessionId: session ?? sessionId, planText: "", errored: true };
    }
    if (session === undefined) {
        return { sessionId: undefined, planText: "", errored: true };
    }
    if (running !== undefined && !turn.model.announced) {
        turn.model.announced = true;
        yield { kind: "init", model: running };
    }
    const wait = idleWait();
    // Started before the phase binds, since a permission the agent asks for holds it.
    const clock = turnWatchdog(turn.timeouts);
    const { queue, held, unbind } = bindPhase(connection, request, session, turn, wait, clock);
    const cancel = (): void => void connection.agent.notify(methods.agent.session.cancel, { sessionId: session }).catch(() => {});
    // A Stop before the session exists reaches an already-aborted signal a bare listener would miss.
    const unwatchAbort = whenAborted(request.signal, cancel);

    let settled = false;
    let response: PromptResponse | undefined;
    let failure: unknown;
    const promptPromise = connection.agent
        .request(methods.agent.session.prompt, { sessionId: session, prompt })
        .then((result) => {
            response = result;
        })
        .catch((error: unknown) => {
            failure = error;
        })
        .finally(() => {
            settled = true;
            wait.wake();
        });

    const pull = watchedPull({ take: () => queue.shift(), settled: () => settled, clock, wait });
    try {
        for (let next = await pull(); next !== SETTLED; next = await pull()) {
            if (next === EXPIRED) {
                // Cancel is best-effort. The process may be serving other conversations' turns, so this one lets go of
                // its session and the connection ends the process only if none is left (acp-connection.ts); sessions
                // die with it, and the next send self-heals.
                cancel();
                unbind();
                connection.abandon(session);
                yield { kind: "error", message: `ACP agent timed out: ${clock.expiry()}. It was stopped; send again to retry.` };
                return { sessionId: session, planText: held.text, errored: true };
            }
            yield next;
        }
        await promptPromise;
        const failed = settledFailure(response, failure, connection.stderrTail);
        if (failed !== undefined) {
            yield { kind: "error", message: failed, ...authCodeOf(failure instanceof RequestError ? failure : undefined) };
        }
        return { sessionId: session, planText: held.text, errored: failed !== undefined };
    } finally {
        unbind();
        unwatchAbort();
    }
}

// One pooled process per id: an installed card's own id, or a native provider's per-account key, since the launch's
// environment is the process's whole identity. A connection failure surfaces as an error frame, then done.
export const createAcpAgent = (connections: AcpConnections, timeouts: TurnTimeouts = DEFAULT_TURN_TIMEOUTS) =>
    async function* runAcpAgent(
        id: string,
        launch: AcpLaunch,
        request: AgentRequest<ContainerCredential>,
        options: AcpTurnOptions = {},
    ): AsyncGenerator<AgentEvent> {
        const model = { wanted: options.model, announced: false };
        yield* vendorTurn(request, {
            open: () => connections.acquire(id, launch, request.spec.cwd),
            unopened: "ACP agent failed to start",
            // A session/new failure or a connection torn down mid-turn, with the agent's own stderr folded in.
            failure: (error, connection) => withStderrTail(failureOf(error), connection.stderrTail()),
            serve: (connection, gate) => {
                // Starts as a no-op; each phase repoints it at its own queue, while the gate outlives the phase.
                const sink = { push: (_event: AgentEvent) => {} };
                // Native image blocks when the agent advertises image prompts; everything else rides the file note.
                return textPlanTurn(ACP, request, connection.capabilities.promptCapabilities?.image === true, (text, images, sessionId, planning) =>
                    runAcpTurn(connection, request, [{ type: "text", text }, ...images.map(imageBlock)], sessionId, {
                        phase: planning ? "plan" : "execute",
                        captureText: planning,
                        timeouts,
                        gate,
                        sink,
                        model,
                    }),
                );
            },
        });
    };
