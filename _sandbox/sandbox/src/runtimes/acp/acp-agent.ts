import {
    type ContentBlock,
    type CreateTerminalRequest,
    type McpServer,
    methods,
    type PromptResponse,
    RequestError,
    type RequestPermissionRequest,
    type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { AgentCapabilities } from "@intentic/sandbox-contract/models/agent-runtimes";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { PermissionMode } from "@intentic/sandbox-contract/schemas/agent";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
import { whenAborted } from "@intentic/base/async";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import type { TurnTaint } from "../../guard/turn-taint.js";
import { imageBlock } from "../../agent/prompt/attachment-images.js";
import { commandFirstTexts } from "../../agent/run/command-turn.js";
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
import { isContextOverflowText } from "../../engines/failure-sentences.js";
import { workspacePath } from "../../sessions/vocabulary/tool-calls.js";
import { opt } from "../../opt.js";
import { answerVendorAsk } from "../decorators/vendor-ask.js";
import { isRateLimited, vendorFailureFrame, type VendorRule, withStderrTail } from "../decorators/vendor-errors.js";
import { textPlanTurn, vendorTurn } from "../decorators/vendor-turn.js";
import type { AcpConnection, AcpConnections } from "./acp-connection.js";
import type { AcpLaunch, AcpSessionMeta } from "./acp-spawn.js";
import { answerElicitation } from "./acp-elicitation.js";
import { acpMcpProxyFile, stdioProxyServer } from "./acp-mcp-proxy.js";
import { sessionUpdateEvent } from "./acp-events.js";
import { recordOptions, thoughtFor } from "./acp-model.js";
import { isBypassMode, modeFor, noteMode, recordModes } from "./acp-modes.js";
import {
    allowedBy,
    decidePermission,
    type PermissionPhase,
    permissionCommand,
    permissionProgram,
    type PersonAsk,
    type PersonDecision,
} from "./acp-permissions.js";
import { terminalProgram } from "./acp-terminal.js";

// The ACP provider adapter, the seam runAgent/createCodexAgent/createOpenCodeAgent share: AgentRequest in, AgentEvent out,
// over any agent speaking the Agent Client Protocol. One warm connection per agent, one session per conversation. A
// documented floor, not the native ceiling: an installed agent owns its model settings, MCP tools pass through only when
// advertised. A native provider on this runtime (Devin) names the model through AcpTurnOptions. What the agent advertises
// per session is used where it is: its modes for the turn's posture (acp-modes.ts), its `thought_level` option for the
// turn's effort, and form elicitation for questions (acp-elicitation.ts).

// What a provider built on this runtime decides per turn beyond the request. An installed agent card decides none of it.
export interface AcpTurnOptions {
    // A value the session's model option offers (acp-model.ts): the session is switched to it before the prompt and the
    // turn announces it. Absent, the agent keeps its own pick and nothing is announced.
    readonly model?: string | undefined;
}

// A model the session's own option does not offer: the account's list moved since the catalog last read it.
class ModelNotOffered extends Error {}

// A session the agent would not take out of its run-without-asking mode, on a turn that asked for a person's approvals
// or whose rulebook is watching: running on would let every call past both.
class ModeNotLeft extends Error {}

// The plan card is the daemon's on every ACP agent, whatever modes it advertises: the protocol has no signal that a plan
// is ready for a yes, so the emulation (plan-mode.ts) runs the two phases, with the agent's own plan mode under the first
// where it has one (acp-modes.ts).
const EMULATED_PLAN: Pick<AgentCapabilities, "permissions"> = { permissions: "plan" };

// How an agent's failure sentences are coded, in this order: a spent allowance first, so the client shows a reset
// countdown and holds the turn, then a session past the model's window, which the daemon re-runs in a fresh one. The
// sentence is the agent's own, so what is not recognized stays a plain failure.
const ACP_FAILURES: readonly VendorRule[] = [
    [isRateLimited, "rate_limit"],
    [isContextOverflowText, "context-overflow"],
];

// The agent's MCP servers: the turn's remote list (every mount at the daemon's MCP door: browsers, the mcp-kind cards and
// the daemon's own servers) over http where the agent advertises http MCP, else as stdio servers through the daemon's
// proxy (acp-mcp-proxy.ts), stdio being the transport every ACP agent must take. In-process SDK servers have no ACP
// projection; the daemon's own reach the agent through the door instead (daemon-servers.ts).
const mcpServersOf = async (request: AgentRequest, connection: AcpConnection): Promise<McpServer[]> => {
    const tools = request.tools.remote ?? [];
    if (tools.length === 0) {
        return [];
    }
    if (connection.capabilities.mcpCapabilities?.http === true) {
        return tools.map((tool) => ({
            type: "http",
            name: tool.name,
            url: tool.url,
            headers: tool.token === undefined ? [] : [{ name: "Authorization", value: `Bearer ${tool.token}` }],
        }));
    }
    const script = await acpMcpProxyFile();
    return tools.map((tool) => stdioProxyServer(tool, script));
};

// The SDK wraps a throwing handler as "Internal error"; the real reason lives in data.details, unwrapped here.
const failureOf = (error: unknown): string => {
    const details = (error as { data?: { details?: unknown } }).data?.details;
    return typeof details === "string" && details !== "" ? details : error instanceof Error ? error.message : "ACP agent failed";
};

type ErrorFrame = Extract<AgentEvent, { kind: "error" }>;

// A failure as its frame: the protocol's own auth_required first (ACP credentials belong to the capability, not a native
// provider account's reconnect flow), then the agent's sentence through the shared rules.
const failureFrame = (message: string, error: unknown): ErrorFrame =>
    error instanceof RequestError && error.code === RequestError.authRequired().code
        ? { kind: "error", message, code: "acp-auth-required" }
        : vendorFailureFrame({ kind: "error", message }, ACP_FAILURES);

// The session a phase runs on: the one asked for when this process holds it or can load it, else a new one, announced. A
// session the agent can't bring back is the coded self-heal every runtime shares: the next send starts fresh.
async function* sessionFor(
    connection: AcpConnection,
    request: AgentRequest,
    sessionId: string | undefined,
    meta: AcpSessionMeta | undefined,
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
                mcpServers: await mcpServersOf(request, connection),
                ...opt("_meta", meta === undefined ? undefined : { ...meta }),
            })
            .then(
                (loaded) => {
                    recordOptions(connection, sessionId, loaded.configOptions);
                    recordModes(connection.modes, sessionId, loaded.modes);
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
        mcpServers: await mcpServersOf(request, connection),
        ...opt("_meta", meta === undefined ? undefined : { ...meta }),
    });
    recordOptions(connection, created.sessionId, created.configOptions);
    recordModes(connection.modes, created.sessionId, created.modes);
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
    return recordOptions(connection, sessionId, answer.configOptions)?.current ?? wanted;
};

// Puts the session on the reasoning depth nearest the turn's effort, where the agent offers a `thought_level` option.
// Advisory, like every runtime's effort: a level the agent refuses leaves its own, and the turn runs on.
const settleThought = async (connection: AcpConnection, sessionId: string, effort: string | undefined): Promise<void> => {
    const thoughts = connection.thoughts.get(sessionId);
    const wanted = effort === undefined || thoughts === undefined ? undefined : thoughtFor(thoughts, effort);
    if (thoughts === undefined || wanted === undefined || wanted === thoughts.current) {
        return;
    }
    const answer = await connection.agent
        .request(methods.agent.session.setConfigOption, { sessionId, configId: thoughts.configId, value: wanted })
        // allow(silent-catch): reasoning depth is advisory; the session keeps the agent's own level
        .catch(() => undefined);
    if (answer !== undefined) {
        recordOptions(connection, sessionId, answer.configOptions);
    }
};

// Puts the session in the mode this phase's posture maps onto (acp-modes.ts `modeFor`); an agent advertising no modes
// is left as it is. A refused switch is tolerated, except out of a bypass mode, which ModeNotLeft refuses the turn over.
const settleMode = async (
    connection: AcpConnection,
    sessionId: string,
    phase: PermissionPhase,
    permissionMode: PermissionMode | undefined,
    rulebookEnforcing: boolean,
): Promise<void> => {
    const modes = connection.modes.get(sessionId);
    const target = modes === undefined ? undefined : modeFor(modes, phase, permissionMode, rulebookEnforcing);
    if (modes === undefined || target === undefined || target === modes.current) {
        return;
    }
    const switched = await connection.agent.request(methods.agent.session.setMode, { sessionId, modeId: target }).then(
        () => true,
        () => false,
    );
    if (switched) {
        noteMode(connection.modes, sessionId, target);
        return;
    }
    if (isBypassMode(modes, modes.current)) {
        throw new ModeNotLeft(`The agent would not leave its ${modes.current} mode, which runs every call without asking. Send again to retry.`);
    }
};

// A command line as the rulebook and the dedupe read it: spacing collapsed, so one call's two spellings match.
const normalizedProgram = (program: string): string => program.trim().replaceAll(/\s+/g, " ");

// The commands a permission let through this phase, each counted once: the agent asks about a call, then runs it through
// terminal/create, and the rulebook already answered the ask, so the create it announced is not asked about again.
const admittedPrograms = () => {
    const counts = new Map<string, number>();
    return {
        add: (program: string): void => {
            const key = normalizedProgram(program);
            counts.set(key, (counts.get(key) ?? 0) + 1);
        },
        take: (program: string): boolean => {
            const key = normalizedProgram(program);
            const count = counts.get(key) ?? 0;
            if (count === 0) {
                return false;
            }
            if (count === 1) {
                counts.delete(key);
            } else {
                counts.set(key, count - 1);
            }
            return true;
        },
    };
};

// The per-tool card a turn in `default` mode puts each call the agent asks about on, the card the Claude Code loop's
// manual posture raises: the agent's own title for the call, the command or file it concerns, and an always only where
// the agent offered one to remember.
const personAsk =
    (request: AgentRequest, signal: AbortSignal, push: (event: AgentEvent) => void): PersonAsk =>
    async (ask: RequestPermissionRequest): Promise<PersonDecision> => {
        const { id, wait } = request.hooks.cards.create("permission", {
            kind: "permission",
            requestId: "",
            decision: "deny",
            feedback: "The turn ended before you answered.",
        });
        const toolName = ask.toolCall.title ?? ask.toolCall.kind ?? "tool";
        const program = permissionProgram(ask);
        const location = ask.toolCall.locations?.[0]?.path;
        push({
            kind: "permission",
            requestId: id,
            toolName,
            reason: "You asked to approve each call in this conversation.",
            ...opt("description", program === toolName ? undefined : program),
            ...opt("path", location === undefined ? undefined : workspacePath(location, request.spec.cwd)),
            ...(ask.options.some((option) => option.kind === "allow_always") ? { alwaysLabel: `Don't ask again for ${toolName}` } : {}),
        });
        const { reply, resolved } = await wait(signal);
        push(resolved);
        return reply.decision === "deny" ? "deny" : reply.decision === "always" ? "always" : "once";
    };

// What one phase reads of its turn: its phase, the turn's rulebook gate (one for the whole turn, its sink repointed per
// phase rather than rebuilt), and the signal that ends with the turn, so a card an agent left open is settled then.
interface PhaseTurn {
    readonly phase: PermissionPhase;
    readonly captureText: boolean;
    readonly gate: CommandGuard;
    // The gate's taint bit, which a daemon tool's outside result marks (turn-relay.ts).
    readonly taint: TurnTaint;
    readonly sink: { push: (event: AgentEvent) => void };
    readonly ended: AbortSignal;
}

// A phase's live half: what the agent sends lands in `queue` (or, while planning, in `text`), and every landing wakes
// the loop. The gate's sink is repointed here, since the gate outlives a phase and the queue does not. `clock` is the
// phase's watchdog, held while a permission, a form or a command is decided: the agent is waiting on the daemon then,
// and a card open on a person is not a stalled agent.
const bindPhase = (connection: AcpConnection, request: AgentRequest, session: string, turn: PhaseTurn, wait: IdleWait, clock: Pick<TurnWatchdog, "hold">) => {
    const queue: AgentEvent[] = [];
    const held = { text: "" };
    turn.sink.push = (event) => {
        queue.push(event);
        wait.wake();
    };
    const push = (event: AgentEvent): void => turn.sink.push(event);
    // A turn in `default` mode puts every call the agent asks about to a person; planning never does, its mutating calls
    // already refused.
    const person = turn.phase === "execute" && request.policy.permissionMode === "default" ? personAsk(request, turn.ended, push) : undefined;
    const admitted = admittedPrograms();
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
                const answer = await decidePermission(permissionRequest, turn.phase, request.signal.aborted, turn.gate, push, person);
                const command = permissionCommand(permissionRequest);
                if (command !== undefined && allowedBy(permissionRequest, answer)) {
                    admitted.add(command);
                }
                return answer;
            } finally {
                release();
            }
        },
        elicit: async (form) => {
            const release = clock.hold();
            try {
                return await answerElicitation(form, { cards: request.hooks.cards, conversationId: request.spec.conversationId, push, signal: turn.ended });
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
                      // The daemon runs this command itself, so the rulebook is asked here, unless the permission the
                      // agent asked about this very command already answered it.
                      admit: async (create: CreateTerminalRequest) => {
                          const program = terminalProgram(create);
                          if (admitted.take(program)) {
                              return;
                          }
                          const answer = await answerVendorAsk(
                              { gate: turn.gate, push, hold: clock.hold },
                              { tool: "terminal", program, cwd: create.cwd ?? undefined, canRefuse: true },
                          );
                          if (!answer.allow) {
                              throw new Error(answer.reason);
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

// The prompt's words as text blocks: one, or a command's words first and the daemon's notes after (command-turn.ts).
const textBlocks = (text: string, command: string | undefined): ContentBlock[] => commandFirstTexts(text, command).map((part) => ({ type: "text", text: part }));

// One prompt turn on one session: resolves/creates/loads it, binds routing, and streams mapped updates until the
// response settles or the watchdog fires. Never emits the terminal `done`; callers do once the whole turn settles.
async function* runAcpTurn(
    connection: AcpConnection,
    request: AgentRequest,
    prompt: ContentBlock[],
    sessionId: string | undefined,
    turn: PhaseTurn & {
        readonly timeouts: TurnTimeouts;
        // The turn's model, settled before every phase's prompt and announced once (`announced` outlives the phase).
        readonly model: { readonly wanted: string | undefined; announced: boolean };
        // The launch's per-session `_meta` (AcpLaunch.sessionMeta).
        readonly sessionMeta: AcpSessionMeta | undefined;
    },
): AsyncGenerator<AgentEvent, PlanPhaseResult> {
    let session: string | undefined;
    let running: string | undefined;
    try {
        session = yield* sessionFor(connection, request, sessionId, turn.sessionMeta);
        if (session !== undefined) {
            running = turn.model.wanted !== undefined ? await settleModel(connection, session, turn.model.wanted) : undefined;
            await settleThought(connection, session, request.spec.effort);
            await settleMode(connection, session, turn.phase, request.policy.permissionMode, turn.gate.enforcing);
        }
    } catch (error) {
        if (error instanceof ModelNotOffered) {
            yield { kind: "error", code: "model-unavailable", message: error.message };
            return { sessionId: session, planText: "", errored: true };
        }
        if (error instanceof ModeNotLeft) {
            yield { kind: "error", message: error.message };
            return { sessionId: session, planText: "", errored: true };
        }
        yield failureFrame(withStderrTail(failureOf(error), connection.stderrTail()), error);
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
    // The daemon's own tools (daemon-servers.ts) reach this phase: a card they raise lands in its stream, a call they
    // answer holds its watchdog, and a script the agent runs through `code` is asked of the turn's gate. Per phase, as the
    // queue and clock are; what a tool did between phases waits in the relay.
    const detach = request.hooks.relay?.attach({ push: turn.sink.push, hold: clock.hold, guard: { gate: turn.gate, taint: turn.taint } });
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
            yield failureFrame(failed, failure);
        }
        return { sessionId: session, planText: held.text, errored: failed !== undefined };
    } finally {
        detach?.();
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
            async *serve (connection, gate, taint) {
                // Starts as a no-op; each phase repoints it at its own queue, while the gate outlives the phase.
                const sink = { push: (_event: AgentEvent) => {} };
                // Ends with the turn, settling any form or approval card an agent that moved on left open.
                const ended = new AbortController();
                try {
                    // Native image blocks when the agent advertises image prompts; everything else rides the file note.
                    yield* textPlanTurn(EMULATED_PLAN, request, connection.capabilities.promptCapabilities?.image === true, (text, images, sessionId, planning) =>
                        runAcpTurn(connection, request, [...textBlocks(text, request.spec.command), ...images.map(imageBlock)], sessionId, {
                            phase: planning ? "plan" : "execute",
                            captureText: planning,
                            timeouts,
                            gate,
                            taint,
                            sink,
                            ended: AbortSignal.any([request.signal, ended.signal]),
                            model,
                            sessionMeta: launch.sessionMeta,
                        }),
                    );
                } finally {
                    ended.abort();
                }
            },
        });
    };
