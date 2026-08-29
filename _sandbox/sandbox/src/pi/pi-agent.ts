import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import type { AcpAgentConfig, AgentCommand, AgentEvent } from "@intentic/sandbox-contract";
import { whenAborted } from "../abort.js";
import type { AgentRequest } from "../agent/agent.js";
import { splitAttachments, withFileNote } from "../agent/attachment-note.js";
import { EXECUTE_PROMPT, type ExecutePhase, PLAN_PREAMBLE, type PlanPhase, runPlanEmulation } from "../agent/plan-emulation.js";
import { withTimeout } from "../acp/acp-connection.js";
import { createTurnGate } from "../guard/turn-gate.js";
import { createPiEventMapper } from "./pi-events.js";
import type { PiEvent, PiProcess, PiSpawn } from "./pi-rpc.js";

/* The Pi provider adapter: the same seam as runAgent/createCodexAgent/createGrokAgent/runAcpAgent,
 * AgentRequest in, AgentEvent frames out, over Pi's RPC mode, resolved from the reserved `pi` agent-kind
 * capability. One process per TURN (Pi persists sessions as files, so resume is a `switch_session` on a
 * fresh process, nothing worth keeping warm holds any state); one Pi session per conversation, and the
 * session id on the wire IS the session file path, which is also what holdsSession checks.
 *
 * What this runtime does and does not do is declared as `capabilitiesOf("pi", …)` in the contract's
 * agent-catalog.ts, and the two abilities that put it above the ACP floor are served here: mid-turn steering
 * is forwarded onto Pi's own `steer` queue, and the turn's reasoning effort rides `set_thinking_level`. Pi
 * runs its bash in-process (no tmux seam), has no MCP surface, and its permission posture is the container
 * boundary, plan mode is the shared two-phase emulation. */

export interface PiTimeouts {
    readonly inactivityMs: number;
    readonly maxTurnMs: number;
}
const DEFAULT_TIMEOUTS: PiTimeouts = { inactivityMs: 120_000, maxTurnMs: 30 * 60_000 };

// Setup commands (switch_session/get_state/set_model/…) answer immediately or the process is not speaking
// the protocol, same hard-race reasoning as ACP's initialize guard.
const SETUP_TIMEOUT_MS = 15_000;

// How long a turn waits for Pi to settle after an abort was sent, before the process is killed outright.
const ABORT_GRACE_MS = 5_000;

const IMAGE_MIME: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
};

// Raster attachments ride the prompt as native Pi ImageContent blocks; unreadable files degrade to a path
// note (the acp-agent shape).
const imageBlocks = async (paths: readonly string[]): Promise<{ images: Record<string, unknown>[]; unread: string[] }> => {
    const images: Record<string, unknown>[] = [];
    const unread: string[] = [];
    for (const path of paths) {
        try {
            const data = await readFile(path);
            images.push({ type: "image", data: data.toString("base64"), mimeType: IMAGE_MIME[extname(path).toLowerCase()] ?? "image/png" });
        } catch {
            unread.push(path);
        }
    }
    return { images, unread };
};

const errorText = (message: string, stderrTail: string): string => {
    const detail = stderrTail.trim();
    return detail === "" ? message : `${message}: ${detail}`;
};

// The turn loop's idle wake latch, swapped for the wait race's resolver while a wait is in flight.
const noopWake = (): void => {};

// The per-process event plumbing the turn loop drains: pushed by the transport's handler, pulled by
// runPiTurn's queue/wake race (the acp-agent pattern).
interface PiTurnState {
    readonly queue: PiEvent[];
    exited: boolean;
    exitCode: number | null;
    wake: () => void;
}

/* Answer Pi's extension UI sub-protocol so a dialog can never hang the turn: this adapter installs no Pi
 * extensions itself, but the workspace may carry project-level ones, and a `select`/`confirm` left
 * unanswered blocks the agent forever. Cancelling is the honest floor (`questions: false` in the capability
 * record), the extension receives its documented "user dismissed" value and carries on. Fire-and-forget
 * methods need no reply and are dropped. */
const answerExtensionUi = (proc: PiProcess, event: PiEvent): void => {
    const method = event["method"];
    if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
        proc.send({ type: "extension_ui_response", id: event["id"], cancelled: true });
    }
};

// How one prompt turn ended: whether anything failed, and, on a `holdText` turn, the text it held back
// instead of streaming, which is the plan the user is about to be asked to approve.
interface PiTurnOutcome {
    readonly errored: boolean;
    readonly planText?: string;
}

// One prompt turn on the warm process: send the prompt, stream mapped events until agent_settled (or a
// watchdog fires, or the process dies). Does NOT emit the terminal `done`, the caller does once the whole
// turn (incl. plan phases) settles.
async function* runPiTurn(
    proc: PiProcess,
    state: PiTurnState,
    request: AgentRequest,
    prompt: Record<string, unknown>,
    timeouts: PiTimeouts,
    holdText = false,
): AsyncGenerator<AgentEvent, PiTurnOutcome> {
    const mapper = createPiEventMapper(request.cwd, holdText);
    // However this turn ends, the verdict folds in what the mapper held back: text the plan phase accumulated,
    // and an error frame that already went out (which is a failure even when the turn itself settled cleanly).
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
    // The CLI is spawned before this point, so a turn stopped during the spawn arrives already aborted and a
    // bare listener would never fire: the loop below would notice the Stop, but Pi itself would never be told.
    const unwatchAbort = whenAborted(request.signal, sendAbort);

    try {
        const accepted = await withTimeout(proc.request(prompt), SETUP_TIMEOUT_MS).catch(() => ({ success: false, error: "no response" }));
        if (!accepted.success) {
            yield { kind: "error", message: errorText(`Pi rejected the prompt: ${accepted.error ?? "unknown error"}`, proc.stderrTail()) };
            return settled(true);
        }

        const turnDeadline = Date.now() + timeouts.maxTurnMs;
        let inactivityDeadline = Date.now() + timeouts.inactivityMs;
        for (;;) {
            const event = state.queue.shift();
            if (event !== undefined) {
                inactivityDeadline = Date.now() + timeouts.inactivityMs;
                if (event.type === "extension_ui_request") {
                    answerExtensionUi(proc, event);
                    continue;
                }
                if (event.type !== "agent_settled") {
                    yield* mapper.map(event);
                    continue;
                }
                const usage = mapper.usage();
                if (usage !== undefined) {
                    yield usage;
                }
                return settled(false);
            }
            if (state.exited) {
                if (request.signal.aborted) {
                    // The user stopped the turn and the process went down with it, that is the stop working.
                    return settled(true);
                }
                yield { kind: "error", message: errorText(`Pi exited mid-turn (code ${state.exitCode ?? "?"})`, proc.stderrTail()) };
                return settled(true);
            }
            // An abort narrows the wait to a grace window: Pi usually settles the run, but a wedged provider
            // call may never, and the user has already asked for their turn back.
            const abortDeadline = request.signal.aborted ? Date.now() + ABORT_GRACE_MS : Number.POSITIVE_INFINITY;
            const waitMs = Math.min(inactivityDeadline, turnDeadline, abortDeadline) - Date.now();
            if (waitMs <= 0) {
                if (request.signal.aborted) {
                    proc.kill();
                    return settled(true);
                }
                // Watchdog: Pi went silent (or ran forever). The kill is what guarantees the turn ends; the
                // session file survives it, so the next send resumes the conversation.
                sendAbort();
                proc.kill();
                yield { kind: "error", message: "Pi timed out, no activity from the agent. It was stopped; send again to retry." };
                return settled(true);
            }
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                new Promise<void>((resolve) => {
                    state.wake = resolve;
                }),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, waitMs);
                }),
            ]);
            clearTimeout(timer);
            state.wake = noopWake;
        }
    } finally {
        unwatchAbort();
    }
}

// Forward the turn's steering queue onto Pi's own steer queue, the real mid-turn injection the capability
// record claims. A steer that lands while Pi is momentarily idle (between plan phases) is refused by the
// protocol; it retries as a follow_up so the message is delivered rather than dropped.
const pumpSteering = (proc: PiProcess, request: AgentRequest): void => {
    const steering = request.steering;
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

// Build the Pi provider for the Services seam. `config` comes from the turn's resolved `pi` capability
// (planPiTurn); a spawn failure surfaces as an error frame, then done.
export const createPiAgent = (spawnPi: PiSpawn, timeouts: PiTimeouts = DEFAULT_TIMEOUTS) =>
    async function* runPiAgent(config: AcpAgentConfig, request: AgentRequest): AsyncGenerator<AgentEvent> {
        const state: PiTurnState = { queue: [], exited: false, exitCode: null, wake: noopWake };
        let proc: PiProcess;
        try {
            proc = spawnPi(config, request.cwd, {
                onEvent: (event) => {
                    state.queue.push(event);
                    state.wake();
                },
                onExit: (code) => {
                    state.exited = true;
                    state.exitCode = code;
                    state.wake();
                },
            });
        } catch (error) {
            yield { kind: "error", message: error instanceof Error ? error.message : "Pi failed to start" };
            yield { kind: "done" };
            return;
        }

        // The turn body, as its own generator so an early return (a dead session, a rejected model pin)
        // still falls through to the one `done` below, a `return` inside the try would skip it.
        async function* serve(): AsyncGenerator<AgentEvent> {
            // Resume: the recorded session id is the Pi session FILE the last turn reported. A file Pi no
            // longer accepts (deleted, corrupted) is the coded self-heal every runtime shares, the client
            // drops the id and the next send starts fresh.
            if (request.sessionId !== undefined) {
                const switched = await withTimeout(proc.request({ type: "switch_session", sessionPath: request.sessionId }), SETUP_TIMEOUT_MS);
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
            /* A pinned model reaches Pi as `provider/model-id` (its own `--model` spelling). No picker offers
             * one (Pi owns its catalog), so a model only arrives deliberately, an automation config, and a
             * pin Pi rejects fails the turn honestly instead of silently serving the default. */
            if (request.model !== undefined && request.model !== "") {
                const slash = request.model.indexOf("/");
                const picked =
                    slash > 0
                        ? await withTimeout(
                              proc.request({ type: "set_model", provider: request.model.slice(0, slash), modelId: request.model.slice(slash + 1) }),
                              SETUP_TIMEOUT_MS,
                          )
                        : { success: false, error: `expected provider/model-id, got "${request.model}"` };
                if (!picked.success) {
                    yield { kind: "error", message: `Pi could not use the model "${request.model}": ${picked.error ?? "unknown error"}` };
                    return;
                }
            }
            // Effort rides Pi's own thinking scale, which shares the wire's tier names. A tier this model
            // does not offer is refused by Pi and deliberately tolerated: reasoning depth is advisory, and a
            // turn must not die on it.
            if (request.effort !== undefined) {
                await withTimeout(proc.request({ type: "set_thinking_level", level: request.effort }), SETUP_TIMEOUT_MS).catch(() => undefined);
            }
            // Pi's extension/skill/template commands, for the composer's `/` popover, invoking one is plain
            // `/name …` prompt text (the get_commands contract). Best-effort: an empty list is not an error.
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

            const { images, others } = splitAttachments(request.attachments);
            const { images: blocks, unread } = await imageBlocks(images);
            const prompt = withFileNote(request.prompt, [...others, ...unread]);

            if (request.permissionMode === "plan") {
                // Plan flow is text-only prompts; attachment paths ride the note (images too, the planning
                // phase reads, it doesn't look at screenshots; keeping phases uniform beats cleverness).
                const planPhase: PlanPhase = async function* (phasePrompt) {
                    const outcome = yield* runPiTurn(proc, state, request, { type: "prompt", message: phasePrompt }, timeouts, true);
                    return {
                        sessionId: typeof sessionFile === "string" ? sessionFile : undefined,
                        planText: outcome.planText,
                        errored: outcome.errored,
                    };
                };
                const executePhase: ExecutePhase = async function* () {
                    yield* runPiTurn(proc, state, request, { type: "prompt", message: EXECUTE_PROMPT }, timeouts);
                };
                yield* runPlanEmulation(
                    request.signal,
                    PLAN_PREAMBLE + withFileNote(request.prompt, [...others, ...images]),
                    request.sessionId,
                    planPhase,
                    executePhase,
                );
            } else {
                yield* runPiTurn(
                    proc,
                    state,
                    request,
                    { type: "prompt", message: prompt, ...(blocks.length > 0 ? { images: blocks } : {}) },
                    timeouts,
                );
            }

            // Context-window fill for the conversation, read once the turn settles. Pi's own estimate, the
            // same number its footer shows. Best-effort: a killed process simply reports nothing.
            const stats = await withTimeout(proc.request({ type: "get_session_stats" }), SETUP_TIMEOUT_MS).catch(() => undefined);
            const context = (stats?.data as { contextUsage?: { tokens?: unknown; contextWindow?: unknown } } | undefined)?.contextUsage;
            if (typeof context?.tokens === "number" && typeof context.contextWindow === "number" && context.contextWindow > 0) {
                yield { kind: "context_usage", tokens: context.tokens, contextWindow: context.contextWindow };
            }
        }

        /* PI IS THE ONE RUNTIME WITH NO CONSULT SEAM, so this publishes the turn's outside-content bit and
         * nothing else: there is no gate to build. Pi runs bash in-process and its RPC raises no approval
         * request, which is what `rulebook: "none"` declares in the capability record and what limitationsOf
         * tells the person about to send a message here.
         *
         * `blind` is why the bit is published at all. A turn nothing can gate has no later moment where "has
         * this read a stranger's words" could be acted on, so it is treated as carrying outside content for its
         * whole life: the wallet's payment gate then asks in chat rather than spending inside a standing
         * delegation that assumed a gate existed (guard/turn-gate.ts). It costs Pi nothing it had. */
        const { release } = createTurnGate(request);
        try {
            yield* serve();
        } catch (error) {
            // A throwing setup (switch_session timeout, a dead transport) surfaces, never swallows.
            yield { kind: "error", message: errorText(error instanceof Error ? error.message : "Pi agent failed", proc.stderrTail()) };
        } finally {
            proc.kill();
            release();
        }
        yield { kind: "done" };
    };
