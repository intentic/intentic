import { type AcpAgentConfig, type AgentCommand, type AgentEvent, PI } from "@intentic/sandbox-contract";
import { whenAborted } from "../../abort.js";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import { withFileNote } from "../../agent/prompt/attachment-note.js";
import { loadAttachments } from "../decorators/attachment-images.js";
import { EXECUTE_PROMPT, PLAN_PREAMBLE, planMode } from "../decorators/plan-mode.js";
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
import { withTimeout } from "../acp/acp-connection.js";
import { vendorTurnGate } from "../decorators/vendor-gate.js";
import { createPiEventMapper } from "./pi-events.js";
import type { PiEvent, PiProcess, PiSpawn } from "./pi-rpc.js";

// Pi provider adapter (same seam as runAgent/createCodexAgent/createGrokAgent/runAcpAgent): AgentRequest in, AgentEvent
// frames out, over Pi's RPC. One process per turn (Pi persists sessions as files; resume is `switch_session` on a fresh
// process); the session id on the wire is the session file path, which is also what holdsSession checks. Above the ACP
// floor it forwards steering onto Pi's `steer` queue and effort onto `set_thinking_level`; no MCP, no tmux, container
// is the permission boundary.

// Setup commands (switch_session/get_state/set_model/…) answer immediately or the process is not speaking the protocol,
// same hard-race reasoning as ACP's initialize guard.
const SETUP_TIMEOUT_MS = 15_000;

// How long a turn waits for Pi to settle after an abort was sent, before the process is killed outright.
const ABORT_GRACE_MS = 5_000;

// The per-process event plumbing the turn loop drains: pushed by the transport's handler, pulled by runPiTurn under the
// turn's deadlines (the acp-agent pattern).
interface PiTurnState {
    readonly queue: PiEvent[];
    exited: boolean;
    exitCode: number | null;
    readonly wait: IdleWait;
}

// Answers Pi's extension UI sub-protocol so a project-level extension's dialog can never hang the turn; cancelling is
// the honest floor (`questions: false`), giving the documented "user dismissed" value. Fire-and-forget methods get no
// reply.
const answerExtensionUi = (proc: PiProcess, event: PiEvent): void => {
    const method = event["method"];
    if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
        proc.send({ type: "extension_ui_response", id: event["id"], cancelled: true });
    }
};

// How one prompt turn ended: whether anything failed, and, on a `holdText` turn, the text it held back instead of
// streaming, the plan the user is about to be asked to approve.
interface PiTurnOutcome {
    readonly errored: boolean;
    readonly planText?: string;
}

// One prompt turn on the warm process: send the prompt, stream mapped events until agent_settled (or a watchdog fires,
// or the process dies). Does NOT emit the terminal `done`, the caller does once the whole turn settles.
async function* runPiTurn(
    proc: PiProcess,
    state: PiTurnState,
    request: AgentRequest,
    prompt: Record<string, unknown>,
    timeouts: TurnTimeouts,
    holdText = false,
): AsyncGenerator<AgentEvent, PiTurnOutcome> {
    const mapper = createPiEventMapper(request.spec.cwd, holdText);
    // The verdict folds in what the mapper held back: accumulated plan text, and whether an error frame already went
    // out (a failure even if the turn itself settled cleanly).
    const settled = (errored: boolean): PiTurnOutcome => {
        const captured = mapper.capture();
        return {
            errored: errored || captured.errored === true,
            ...(captured.planText !== undefined ? { planText: captured.planText } : {}),
        };
    };

    let abortSent = false;
    const sendAbort = (): void => {
        if (!abortSent) {
            abortSent = true;
            void proc.request({ type: "abort" });
        }
    };
    // The process is spawned before this point, so a turn stopped during spawn arrives already aborted; a bare listener
    // would never fire, and Pi would never be told.
    const unwatchAbort = whenAborted(request.signal, sendAbort);

    try {
        const accepted = await withTimeout(proc.request(prompt), SETUP_TIMEOUT_MS).catch(() => ({ success: false, error: "no response" }));
        if (!accepted.success) {
            yield { kind: "error", message: withStderrTail(`Pi rejected the prompt: ${accepted.error ?? "unknown error"}`, proc.stderrTail()) };
            return settled(true);
        }

        const pull = watchedPull({
            take: () => state.queue.shift(),
            settled: () => state.exited,
            clock: turnWatchdog(timeouts),
            wait: state.wait,
            // An abort narrows the wait to a grace window: Pi usually settles the run, but a wedged provider call may
            // never, and the user has already asked for their turn back.
            until: () => (request.signal.aborted ? Date.now() + ABORT_GRACE_MS : undefined),
        });
        for (let next = await pull(); next !== EXPIRED; next = await pull()) {
            if (next === SETTLED) {
                if (request.signal.aborted) {
                    // The user stopped the turn and the process went down with it, that is the stop working.
                    return settled(true);
                }
                yield { kind: "error", message: withStderrTail(`Pi exited mid-turn (code ${state.exitCode ?? "?"})`, proc.stderrTail()) };
                return settled(true);
            }
            if (next.type === "extension_ui_request") {
                answerExtensionUi(proc, next);
                continue;
            }
            if (next.type !== "agent_settled") {
                yield* mapper.map(next);
                continue;
            }
            const usage = mapper.usage();
            if (usage !== undefined) {
                yield usage;
            }
            return settled(false);
        }
        if (request.signal.aborted) {
            proc.kill();
            return settled(true);
        }
        // Watchdog: Pi went silent (or ran forever). The kill is what guarantees the turn ends; the session file survives
        // it, so the next send resumes the conversation.
        sendAbort();
        proc.kill();
        yield { kind: "error", message: "Pi timed out, no activity from the agent. It was stopped; send again to retry." };
        return settled(true);
    } finally {
        unwatchAbort();
    }
}

// Forwards the turn's steering queue onto Pi's own steer queue, the real mid-turn injection the capability record
// claims. A steer that lands while Pi is momentarily idle (between plan phases) is refused by the protocol; it retries
// as a follow_up so the message is delivered rather than dropped.
const pumpSteering = (proc: PiProcess, request: AgentRequest): void => {
    const steering = request.spec.steering;
    if (steering === undefined) {
        return;
    }
    void (async () => {
        for await (const text of steering) {
            const steered = await proc.request({ type: "steer", message: text });
            if (!steered.success) {
                await proc.request({ type: "follow_up", message: text });
            }
        }
    })();
};

// Builds the Pi provider for the Services seam. `config` comes from the turn's resolved `pi` capability (planPiTurn); a
// spawn failure surfaces as an error frame, then done.
export const createPiAgent = (spawnPi: PiSpawn, timeouts: TurnTimeouts = DEFAULT_TURN_TIMEOUTS) =>
    async function* runPiAgent(config: AcpAgentConfig, request: AgentRequest<ContainerCredential>): AsyncGenerator<AgentEvent> {
        const state: PiTurnState = { queue: [], exited: false, exitCode: null, wait: idleWait() };
        let proc: PiProcess;
        try {
            proc = spawnPi(config, request.spec.cwd, {
                onEvent: (event) => {
                    state.queue.push(event);
                    state.wait.wake();
                },
                onExit: (code) => {
                    state.exited = true;
                    state.exitCode = code;
                    state.wait.wake();
                },
            });
        } catch (error) {
            yield { kind: "error", message: error instanceof Error ? error.message : "Pi failed to start" };
            yield { kind: "done" };
            return;
        }

        // The turn body, as its own generator so an early return (a dead session, a rejected model pin) still falls
        // through to the one `done` below; a `return` inside the try would skip it.
        async function* serve(): AsyncGenerator<AgentEvent> {
            // Resume: the recorded session id is the Pi session file the last turn reported. A file Pi no longer
            // accepts is the coded self-heal every runtime shares: the client drops the id and the next send starts
            // fresh.
            if (request.spec.sessionId !== undefined) {
                const switched = await withTimeout(proc.request({ type: "switch_session", sessionPath: request.spec.sessionId }), SETUP_TIMEOUT_MS);
                if (!switched.success) {
                    yield {
                        kind: "error",
                        code: "session-not-found",
                        message: "Pi no longer has this chat's session. Send again to start fresh.",
                    };
                    return;
                }
            }
            const stateResponse = await withTimeout(proc.request({ type: "get_state" }), SETUP_TIMEOUT_MS);
            const sessionFile = (stateResponse.data as { sessionFile?: unknown } | undefined)?.sessionFile;
            if (typeof sessionFile === "string" && sessionFile !== "") {
                yield { kind: "session", sessionId: sessionFile };
            }
            // A pinned model reaches Pi as `provider/model-id` (its own `--model` spelling); no picker offers one, so
            // it only arrives deliberately (an automation config), and a rejected pin fails the turn honestly.
            if (request.spec.model !== undefined && request.spec.model !== "") {
                const slash = request.spec.model.indexOf("/");
                const picked =
                    slash > 0
                        ? await withTimeout(
                              proc.request({
                                  type: "set_model",
                                  provider: request.spec.model.slice(0, slash),
                                  modelId: request.spec.model.slice(slash + 1),
                              }),
                              SETUP_TIMEOUT_MS,
                          )
                        : { success: false, error: `expected provider/model-id, got "${request.spec.model}"` };
                if (!picked.success) {
                    yield { kind: "error", message: `Pi could not use the model "${request.spec.model}": ${picked.error ?? "unknown error"}` };
                    return;
                }
            }
            // Effort rides Pi's own thinking scale (shares the wire's tier names); a tier the model doesn't offer is
            // refused by Pi and tolerated, since reasoning depth is advisory.
            if (request.spec.effort !== undefined) {
                await withTimeout(proc.request({ type: "set_thinking_level", level: request.spec.effort }), SETUP_TIMEOUT_MS).catch(() => undefined);
            }
            // Pi's extension/skill/template commands, for the composer's `/` popover; invoking one is plain `/name …`
            // prompt text (the get_commands contract). Best-effort: an empty list is not an error.
            const commands = await withTimeout(proc.request({ type: "get_commands" }), SETUP_TIMEOUT_MS).catch(() => undefined);
            const items = (commands?.data as { commands?: { name?: unknown; description?: unknown }[] } | undefined)?.commands;
            if (Array.isArray(items) && items.length > 0) {
                const mapped: AgentCommand[] = items
                    .filter((entry) => typeof entry.name === "string")
                    .map((entry) => ({ name: entry.name as string, description: typeof entry.description === "string" ? entry.description : "" }));
                if (mapped.length > 0) {
                    yield { kind: "commands", items: mapped };
                }
            }

            pumpSteering(proc, request);

            // Raster attachments ride the prompt as native Pi ImageContent blocks; unreadable files degrade to a path note.
            const attached = await loadAttachments(request.spec, true);
            const blocks = attached.images.map((image) => ({ type: "image", data: image.data, mimeType: image.mimeType }));
            const prompt = withFileNote(request.spec.prompt, [...attached.files, ...attached.unread]);

            yield* planMode(
                PI,
                request,
                () => ({
                    // Plan flow is text-only prompts; attachment paths, images included, ride the note, since the planning
                    // phase reads rather than looks at screenshots.
                    prompt: PLAN_PREAMBLE + withFileNote(request.spec.prompt, [...attached.files, ...attached.pictures]),
                    async *plan(phasePrompt) {
                        const outcome = yield* runPiTurn(proc, state, request, { type: "prompt", message: phasePrompt }, timeouts, true);
                        return {
                            sessionId: typeof sessionFile === "string" ? sessionFile : undefined,
                            planText: outcome.planText,
                            errored: outcome.errored,
                        };
                    },
                    execute: () => runPiTurn(proc, state, request, { type: "prompt", message: EXECUTE_PROMPT }, timeouts),
                }),
                () =>
                    runPiTurn(proc, state, request, { type: "prompt", message: prompt, ...(blocks.length > 0 ? { images: blocks } : {}) }, timeouts),
            );

            // Context-window fill for the conversation, read once the turn settles. Pi's own estimate, the same number
            // its footer shows. Best-effort: a killed process simply reports nothing.
            const stats = await withTimeout(proc.request({ type: "get_session_stats" }), SETUP_TIMEOUT_MS).catch(() => undefined);
            const context = (stats?.data as { contextUsage?: { tokens?: unknown; contextWindow?: unknown } } | undefined)?.contextUsage;
            if (typeof context?.tokens === "number" && typeof context.contextWindow === "number" && context.contextWindow > 0) {
                yield { kind: "context_usage", tokens: context.tokens, contextWindow: context.contextWindow };
            }
        }

        // Pi has no consult seam: no permission request ever arrives to gate, so only the outside-content bit is
        // published (`rulebook: "none"`). Treated as carrying outside content for its whole life, since nothing here
        // can later act on it; the wallet's payment gate asks in chat instead.
        const { release } = vendorTurnGate(request);
        try {
            yield* serve();
        } catch (error) {
            // A throwing setup (switch_session timeout, a dead transport) surfaces, never swallows.
            yield { kind: "error", message: withStderrTail(error instanceof Error ? error.message : "Pi agent failed", proc.stderrTail()) };
        } finally {
            proc.kill();
            release();
        }
        yield { kind: "done" };
    };
