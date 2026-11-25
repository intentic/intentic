import {
    type ContentBlock,
    type CreateTerminalRequest,
    methods,
    type PromptResponse,
    type RequestPermissionRequest,
    type SessionNotification,
} from "@agentclientprotocol/sdk/unstable";
import { ACP, type AgentCapabilities } from "@intentic/sandbox-contract/models/agent-runtimes";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { agentSessionName } from "@intentic/sandbox-contract/session-names";
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
    type TurnWatchdog,
    turnWatchdog,
    withTurnCap,
    expiredFrame,
} from "../decorators/turn-watchdog.js";
import { workspacePath } from "../../sessions/vocabulary/tool-calls.js";
import { opt } from "../../opt.js";
import { answerVendorAsk } from "../decorators/vendor-ask.js";
import { withStderrTail } from "../../engines/failure-sentences.js";
import { textPlanTurn, vendorTurn } from "../decorators/vendor-turn.js";
import { type AcpConnection, type AcpConnections, releasingSession, type TurnHooks } from "./acp-connection.js";
import type { AcpLaunch, AcpSessionMeta } from "./acp-spawn.js";
import { answerElicitation, answerVendorQuestion } from "./acp-elicitation.js";
import { type ChildSession, childFrame } from "@intentic/acp-events/dialects";
import { sessionUpdateEvent } from "./acp-events.js";
import { allowedBy, type PersonDecision, refusePermission } from "@intentic/acp-events/answers";
import { decidePermission, type PermissionPhase, permissionCommand, permissionProgram, type PersonAsk } from "./acp-permissions.js";
import { acpTerminalShell, terminalProgram } from "./acp-terminal.js";
import { promptUsage } from "@intentic/acp-events/usage";
import { type AcpTimeouts, cancelOnStop, phasePull, sealedWords } from "./acp-prompt.js";
import { failureFrame, failureOf, openPhaseSession } from "./acp-session-setup.js";
import { tmuxRunEnabled } from "../../agent/tools/agent-terminals.js";

// The ACP provider adapter, the seam runAgent/createCodexAgent/createOpenCodeAgent share: AgentRequest in, AgentEvent out,
// over any agent speaking the Agent Client Protocol. One warm connection per agent, one session per conversation. A
// documented floor, not the native ceiling: MCP tools pass through only when advertised, and a turn names a model through
// AcpTurnOptions only where someone picked one (a native provider's catalog, a spawn naming one). What the agent advertises
// per session is used where it is: its modes for the turn's posture (acp-events modes.ts), its `thought_level` option for the
// turn's effort, and form elicitation for questions (acp-elicitation.ts).

// What a provider built on this runtime decides per turn beyond the request: Devin's and the vendor CLIs' arms from their
// catalogs, an installed agent's from the model its turn names (acp-adapter.ts).
export interface AcpTurnOptions {
    // A value the session's model option offers (acp-events model.ts): the session is switched to it before the prompt and the
    // turn announces it. Absent, the agent keeps its own pick and nothing is announced.
    readonly model?: string | undefined;
}


// The plan card is the daemon's on every ACP agent, whatever modes it advertises: the protocol has no signal that a plan
// is ready for a yes, so the emulation (plan-mode.ts) runs the two phases, with the agent's own plan mode under the first
// where it has one (acp-events modes.ts).
const EMULATED_PLAN: Pick<AgentCapabilities, "permissions" | "editChecks"> = { permissions: "plan", editChecks: ACP.editChecks };





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
    // A sealed request (agent-request.ts `policy.sealed`): every call the agent asks about is refused, no form or
    // terminal is offered, and nobody is asked, since the prompt is everything the model reads.
    readonly sealed: boolean;
    readonly gate: CommandGuard;
    // The gate's taint bit, which a daemon tool's outside result marks (turn-relay.ts).
    readonly taint: TurnTaint;
    readonly sink: { push: (event: AgentEvent) => void };
    readonly ended: AbortSignal;
}

// How a phase reads what the agent says: its updates into the queue (a child session's under the call that spawned it,
// a planning phase's answer held back as the plan), and what its dialect read beyond the protocol.
const phaseReading = (
    connection: AcpConnection,
    request: AgentRequest,
    captureText: boolean,
    into: { readonly queue: AgentEvent[]; readonly held: { text: string }; readonly wake: () => void },
): Pick<TurnHooks, "onUpdate"> & Required<Pick<TurnHooks, "onFrames">> => ({
    onUpdate: (notification: SessionNotification, child?: ChildSession): void => {
        const update = notification.update;
        if (child === undefined && captureText && update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
            // Plan phase: the agent's answer is the plan, held back rather than streamed as deltas.
            into.held.text += update.content.text;
            into.wake();
            return;
        }
        const read = sessionUpdateEvent(update, request.spec.cwd, connection.terminalExit, connection.dialect);
        const event = read === undefined || child === undefined ? read : childFrame(read, child, notification.sessionId);
        if (event !== undefined) {
            into.queue.push(event);
        }
        into.wake();
    },
    // Called with no frames too, so a turn held open on the agent's own wake-up looks again.
    onFrames: (events) => {
        into.queue.push(...events);
        into.wake();
    },
});

// The cards a phase asks a person on: a form the agent asks for (ACP elicitation) and a question it asks through a
// request of its own (Grok's ask-user tool). Either holds the watchdog while the card is open.
const cardAsks = (request: AgentRequest, push: (event: AgentEvent) => void, ended: AbortSignal, clock: Pick<TurnWatchdog, "hold">): Pick<TurnHooks, "elicit" | "ask"> => {
    const held = async <T>(ask: () => Promise<T>): Promise<T> => {
        const release = clock.hold();
        try {
            return await ask();
        } finally {
            release();
        }
    };
    const context = { cards: request.hooks.cards, conversationId: request.spec.conversationId, push, signal: ended };
    return {
        elicit: (form) => held(() => answerElicitation(form, context)),
        ask: (question) => held(() => answerVendorQuestion(question, context)),
    };
};

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
    const { onUpdate, onFrames } = phaseReading(connection, request, turn.captureText, { queue, held, wake: wait.wake });
    // terminal/create runs in the conversation's own tmux session; the first one surfaces it in the panel.
    const tmuxSession = agentSessionName(session);
    const shell = acpTerminalShell(request, session, tmuxRunEnabled());
    let terminalSurfaced = false;
    if (turn.sealed) {
        // No form (absent declines it) and no terminal (absent refuses it); a permission is refused without asking.
        return { queue, held, unbind: connection.bindTurn(session, { onUpdate, onFrames, permission: async (permissionRequest) => refusePermission(permissionRequest) }) };
    }
    const unbind = connection.bindTurn(session, {
        onUpdate,
        onFrames,
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
        ...cardAsks(request, push, turn.ended, clock),
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
                          const answer = admitted.take(program)
                              ? { allow: true as const }
                              : await answerVendorAsk(
                                    { gate: turn.gate, push, hold: clock.hold },
                                    { tool: "terminal", program, cwd: create.cwd ?? undefined, canRefuse: true },
                                );
                          if (!answer.allow) {
                              throw new Error(answer.reason);
                          }
                          // Then run as every judged shell runs a line (acp-terminal.ts acpTerminalShell).
                          return shell.prepare(create);
                      },
                  },
              }
            : {}),
    });
    const release = (): void => {
        unbind();
        void shell.dispose();
    };
    return { queue, held, unbind: release };
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
        readonly timeouts: AcpTimeouts;
        // The turn's model, settled before every phase's prompt and announced once (`announced` outlives the phase).
        readonly model: { readonly wanted: string | undefined; announced: boolean };
        // The launch's per-session `_meta` (AcpLaunch.sessionMeta).
        readonly sessionMeta: AcpSessionMeta | undefined;
    },
): AsyncGenerator<AgentEvent, PlanPhaseResult> {
    const { session, running, failed: unopened } = yield* openPhaseSession(connection, request, sessionId, turn);
    if (unopened) {
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
    const { cancel, unwatch: unwatchAbort } = cancelOnStop(connection, session, request.signal, wait);
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
    // Settled once the prompt has answered and the agent owes the session no wake-up of its own (a background subagent
    // still running, or one that said it will report back): what the wake says lands on this turn, not on no turn. The
    // watchdog still bounds the wait; a stop's grace still ends it.
    const pull = phasePull(queue, () => settled && !connection.reader.holding(session), { clock, wait, signal: request.signal, graceMs: turn.timeouts.abortGraceMs });
    try {
        for (let next = await pull(); next !== SETTLED; next = await pull()) {
            if (next === EXPIRED) {
                // Cancel is best-effort. The process may be serving other conversations' turns, so this one lets go of
                // its session and the connection ends the process only if none is left (acp-connection.ts); sessions
                // die with it, and the next send self-heals.
                cancel();
                unbind();
                connection.abandon(session);
                if (!request.signal.aborted) {
                    yield expiredFrame(clock, (why) => `ACP agent timed out: ${why}. It was stopped; send again to retry.`);
                }
                return { sessionId: session, planText: held.text, errored: true };
            }
            yield next;
        }
        await promptPromise;
        const used = promptUsage(connection, session, response);
        if (used !== undefined) {
            yield used;
        }
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
export const createAcpAgent = (connections: AcpConnections, timeouts: AcpTimeouts = DEFAULT_TURN_TIMEOUTS) =>
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
                const phase = {
                    timeouts: withTurnCap(timeouts, request.spec.turnCapMs),
                    gate,
                    taint,
                    sink,
                    ended: AbortSignal.any([request.signal, ended.signal]),
                    model,
                    sessionMeta: launch.sessionMeta,
                };
                try {
                    if (request.policy.sealed === true) {
                        // A helper's one question on a fresh session with nothing mounted (mcpServersOf reads an empty
                        // list), in the agent's read-only plan mode where it has one, its answer streamed rather than
                        // held. ACP has no system prompt channel, so it rides in front of the words, as Cursor's does.
                        // Nobody resumes a helper's session, so it ends with its answer, or with the helper stopped.
                        yield* releasingSession(
                            connection,
                            runAcpTurn(connection, request, [{ type: "text", text: sealedWords(request) }], undefined, {
                                ...phase,
                                phase: "plan",
                                captureText: false,
                                sealed: true,
                            }),
                        );
                        return;
                    }
                    // Native image blocks when the agent advertises image prompts; everything else rides the file note.
                    yield* textPlanTurn(EMULATED_PLAN, request, connection.capabilities.promptCapabilities?.image === true, (text, images, sessionId, planning) =>
                        runAcpTurn(connection, request, [...textBlocks(text, request.spec.command), ...images.map(imageBlock)], sessionId, {
                            ...phase,
                            phase: planning ? "plan" : "execute",
                            captureText: planning,
                            sealed: false,
                        }),
                    );
                } finally {
                    ended.abort();
                }
            },
        });
    };
