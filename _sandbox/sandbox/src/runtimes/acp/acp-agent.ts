import { type ContentBlock, type McpServer, methods, type PromptResponse, RequestError, type SessionNotification } from "@agentclientprotocol/sdk";
import { ACP, type AcpAgentConfig, type AgentEvent } from "@intentic/sandbox-contract";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { whenAborted } from "@intentic/base/async";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import { imageBlock } from "../decorators/attachment-images.js";
import type { PlanPhaseResult } from "../decorators/plan-mode.js";
import {
    DEFAULT_TURN_TIMEOUTS,
    EXPIRED,
    idleWait,
    type IdleWait,
    SETTLED,
    type TurnTimeouts,
    turnWatchdog,
    watchedPull,
} from "../decorators/turn-watchdog.js";
import { withStderrTail } from "../decorators/vendor-errors.js";
import { textPlanTurn, vendorTurn } from "../decorators/vendor-turn.js";
import type { AcpConnection, AcpConnections } from "./acp-connection.js";
import { sessionUpdateEvent } from "./acp-events.js";
import { decidePermission, type PermissionPhase } from "./acp-permissions.js";

// The ACP provider adapter, the seam runAgent/createCodexAgent/createOpenCodeAgent share: AgentRequest in, AgentEvent out,
// over any agent speaking the Agent Client Protocol. One warm connection per agent, one session per conversation. A
// documented floor, not the native ceiling: the agent owns its model settings, MCP tools pass through only when
// advertised.

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
        // Only the agent's own refusal means the session is gone: a connection that dropped mid-load throws on, so the
        // client keeps the id instead of discarding a session nobody said was lost.
        const refused = await connection.agent
            .request(methods.agent.session.load, {
                sessionId,
                cwd: request.spec.cwd,
                mcpServers: mcpServersOf(request, connection),
            })
            .then(
                () => false,
                (error: unknown) => {
                    if (error instanceof RequestError) {
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
    connection.sessions.add(created.sessionId);
    yield { kind: "session", sessionId: created.sessionId };
    return created.sessionId;
}

// A phase's live half: what the agent sends lands in `queue` (or, while planning, in `text`), and every landing wakes
// the loop. The gate's sink is repointed here, since the gate outlives a phase and the queue does not.
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
        permission: (permissionRequest) =>
            decidePermission(permissionRequest, turn.phase, request.signal.aborted, turn.gate, (event) => turn.sink.push(event)),
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
    },
): AsyncGenerator<AgentEvent, PlanPhaseResult> {
    const session = yield* sessionFor(connection, request, sessionId);
    if (session === undefined) {
        return { sessionId: undefined, planText: "", errored: true };
    }
    const wait = idleWait();
    const { queue, held, unbind } = bindPhase(connection, request, session, turn, wait);
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

    const clock = turnWatchdog(turn.timeouts);
    const pull = watchedPull({ take: () => queue.shift(), settled: () => settled, clock, wait });
    try {
        for (let next = await pull(); next !== SETTLED; next = await pull()) {
            if (next === EXPIRED) {
                // Cancel is best-effort; the kill is not. Sessions die with the process; the next send self-heals.
                cancel();
                connection.kill();
                yield { kind: "error", message: `ACP agent timed out: ${clock.expiry()}. It was stopped; send again to retry.` };
                return { sessionId: session, planText: held.text, errored: true };
            }
            yield next;
        }
        await promptPromise;
        const failed = settledFailure(response, failure, connection.stderrTail);
        if (failed !== undefined) {
            yield { kind: "error", message: failed };
        }
        return { sessionId: session, planText: held.text, errored: failed !== undefined };
    } finally {
        unbind();
        unwatchAbort();
    }
}

// id/config come from the turn's resolved agent-kind capability (streamAgent's dispatch); a connection failure surfaces
// as an error frame, then done.
export const createAcpAgent = (connections: AcpConnections, timeouts: TurnTimeouts = DEFAULT_TURN_TIMEOUTS) =>
    async function* runAcpAgent(id: string, config: AcpAgentConfig, request: AgentRequest<ContainerCredential>): AsyncGenerator<AgentEvent> {
        yield* vendorTurn(request, {
            open: () => connections.acquire(id, config, request.spec.cwd),
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
                    }),
                );
            },
        });
    };
