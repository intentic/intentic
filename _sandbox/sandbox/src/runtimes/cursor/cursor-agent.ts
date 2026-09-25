import type { AgentOptions, ModelSelection, Run, SDKAgent, SendOptions } from "@cursor/sdk";
import { type AgentEvent, CURSOR } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { whenAborted } from "@intentic/base/async";
import { type SteeringChannel, steeringRelay } from "../../agent/checkpoints/agent-steering.js";
import type { AgentRequest, CursorCredential } from "../../agent/providers/agent-request.js";
import { EventQueue } from "../../agent/run/event-queue.js";
import { splitAttachments, withFileNote } from "../../agent/prompt/attachment-note.js";
import { EXECUTE_PROMPT, PLAN_PREAMBLE, planMode } from "../decorators/plan-mode.js";
import { vendorTurnGate } from "../decorators/vendor-gate.js";
import type { CursorCatalog } from "./cursor-catalog.js";
import { createCursorEventMapper } from "./cursor-events.js";
import type { CursorHookService } from "./cursor-hooks.js";
import { selectionFor } from "./cursor-models.js";
import { CURSOR_SDK_MISSING, cursorSdk } from "./cursor-sdk.js";
import { cursorCustomTools, cursorMcpServers, TOOLS_WITHHELD } from "./cursor-tools.js";

// Cursor provider adapter: same AgentRequest-in/AgentEvent-out seam as createCodexAgent/createOpenCodeAgent/runPiAgent,
// over @cursor/sdk's local agent runtime. Runs in-process, not a child process, so the daemon's own functions can be
// tools; reads only the delta stream from `send({ onDelta })`, not the overlapping `run.stream()`.

export interface CursorAgentDeps {
    readonly catalog: CursorCatalog;
    readonly hooks: CursorHookService;
    readonly logger: Logger;
}

// Grace period for a cancel to unwind Cursor's tool calls before frames stop; a request, not a kill.
const CANCEL_GRACE_MS = 5_000;

// How long a phase waits for its first delta before calling the run stalled. Bounds the opening only: once deltas flow,
// a silent gap is a tool call running long, and a cap there would end working turns.
export const FIRST_DELTA_MS = 5 * 60_000;

// Coded like a 5xx so the outage breaker queues the turn and resumes it on its own session, rather than stranding it.
const CURSOR_STALLED = "Cursor took the turn and then sent nothing at all; treating the provider as unavailable.";

// Maps everything the SDK can throw to the coded error frames auto-resume/reconnect already key off, matched by the
// SDK's exported error classes, not message text (which is not public API).
const codedError = async (error: unknown, sdk: Awaited<ReturnType<typeof cursorSdk>>): Promise<Extract<AgentEvent, { kind: "error" }>> => {
    const message = error instanceof Error && error.message !== "" ? error.message : "The Cursor turn failed.";
    if (sdk === undefined) {
        return { kind: "error", message };
    }
    if (error instanceof sdk.RateLimitError) {
        return { kind: "error", message, code: "rate_limit" };
    }
    if (error instanceof sdk.AuthenticationError) {
        // Not subscription-required: account is connected, the key stopped working; fix is re-signing the same row.
        return { kind: "error", message: `${message} Connect your Cursor account again in Sandbox ▸ Agent.` };
    }
    if (error instanceof sdk.AgentBusyError) {
        return { kind: "error", message, code: "agent-busy" };
    }
    if (error instanceof sdk.AgentNotFoundError) {
        // This machine lost the named agent (store cleared, a rebuild); client drops it, next send opens fresh.
        return { kind: "error", message, code: "session-not-found" };
    }
    // UnknownAgentError is deliberately not matched above: it is the SDK's catch-all for any error it cannot classify
    // (its converter ends in `new UnknownAgentError(message)`), not "unknown agent". Coding it session-not-found hid
    // real failures as a silently dropped session, the wedged "already has active run" among them.
    if (error instanceof sdk.NetworkError) {
        return { kind: "error", message, code: "provider-outage" };
    }
    return { kind: "error", message };
};

// Ends one phase's drain without ending the turn's queue: a plan turn runs two phases, and the tools that push into it
// were bound to it once, when the agent was created.
const PHASE_END = Symbol("cursor-phase-end");
type PhaseItem = AgentEvent | typeof PHASE_END;

// Cursor's `plan` mode is read-only by the runtime's own enforcement; `agent` is the full toolbox. Every other posture
// this repo asks for collapses onto `agent`: finer approvals are the command rulebook's job, not a mode.
const modeFor = (planning: boolean): "plan" | "agent" => (planning ? "plan" : "agent");

// Mid-turn injection rides the live Run, not the prompt, so the pump waits for the handle `send` resolves rather than
// racing it. Only `complete_delivered` transfers ownership; every other ack means the run would not take the message,
// and it stays in the relay for the next phase of a plan turn (there is none after the last, so it is reported).
// `Run.steer` ships in @cursor/sdk 1.0.31, the version engines.json blesses and every turn loads, and is declared
// optional there; a dev checkout's node_modules can still hold an older copy whose types lack it, so it is reached by
// shape rather than through the Run type.
type SteerableRun = { readonly steer?: (text: string) => Promise<"complete_delivered" | "revert_to_followup"> };

const steerInto = async (started: Promise<Run | undefined>, channel: SteeringChannel, logger: Logger): Promise<void> => {
    for await (const text of channel.steering) {
        const run = (await started) as SteerableRun | undefined;
        const outcome = await run?.steer?.(text).catch((error: unknown) => {
            logger.warn({ err: error }, "cursor: steering message rejected by the run");
            return undefined;
        });
        if (outcome !== "complete_delivered") {
            logger.warn({ outcome }, "cursor: steering message not taken by the running turn");
        }
    }
};

export const createCursorAgent = (deps: CursorAgentDeps) => {
    // Forwards one phase of the turn's queue; the caller emits `done` once, since a plan turn runs two of these.
    // While planning, the assistant's prose is captured, not streamed, becoming the plan text.
    async function* runPhase(
        agent: SDKAgent,
        request: AgentRequest,
        queue: EventQueue<PhaseItem>,
        prompt: string,
        selection: ModelSelection | undefined,
        planning: boolean,
        channel: SteeringChannel | undefined,
        force: boolean,
    ): AsyncGenerator<AgentEvent, { errored: boolean; planText: string | undefined }> {
        const mapper = createCursorEventMapper(request.spec.cwd, planning);
        let sawDelta = false;
        const options: SendOptions = {
            mode: modeFor(planning),
            ...(selection !== undefined ? { model: selection } : {}),
            // Only `force` rides the per-send `local`; custom tools not named here fall back to the agent's own.
            ...(force ? { local: { force: true } } : {}),
            // Mapped where it arrives rather than where it is read: the drain below can be parked on a tool handler,
            // and what the mapper captures is read the moment the phase ends.
            onDelta: ({ update }) => {
                sawDelta = true;
                for (const frame of mapper.map(update)) {
                    queue.push(frame);
                }
            },
        };

        // Once per phase, however many of the three ways to end one fire; a second sentinel would end the next phase
        // before it had streamed anything.
        let ended = false;
        const endPhase = (): void => {
            if (ended) {
                return;
            }
            ended = true;
            queue.push(PHASE_END);
        };

        let sendError: unknown;
        // Not awaited: frames arrive via onDelta while this resolves; awaiting first would buffer the turn's opening.
        const started: Promise<Run | undefined> = agent.send(prompt, options).catch((error: unknown) => {
            sendError = error;
            endPhase();
            return undefined;
        });

        // Covers both silences the SDK can hold a turn in: a `send` that never resolves, and a run that resolves and
        // then never deltas. Cancel is best-effort, so the phase ends on this timer rather than on the cancel.
        let stalled = false;
        const stall = setTimeout(() => {
            if (sawDelta) {
                return;
            }
            stalled = true;
            void started.then((handle) => handle?.cancel().catch(() => undefined));
            endPhase();
        }, FIRST_DELTA_MS);
        stall.unref();

        // Stop cancels the run instead of abandoning it, so Cursor unwinds tool calls and the transcript ends resolved.
        const onAbort = (): void => {
            void started.then((handle) => handle?.cancel().catch(() => undefined));
            setTimeout(endPhase, CANCEL_GRACE_MS).unref();
        };
        // A pre-pull Stop hits an aborted signal no listener catches; unwatched, send starts a run nothing can cancel.
        const unwatchAbort = whenAborted(request.signal, onAbort);

        // Not awaited: it lives as long as this phase's channel, and the frames below are what the turn is waiting on.
        if (channel !== undefined) {
            void steerInto(started, channel, deps.logger);
        }

        // Ends the phase when the run itself finishes, ending the drain below.
        let settled = false;
        const finished = started.then(async (handle) => {
            if (handle === undefined) {
                return undefined;
            }
            const result = await handle.wait().catch((error: unknown) => {
                sendError = error;
                return undefined;
            });
            settled = true;
            endPhase();
            return result;
        });

        let errored = false;
        try {
            for await (const item of queue) {
                if (item === PHASE_END) {
                    break;
                }
                if (item.kind === "error") {
                    errored = true;
                }
                yield item;
            }
            // Only the run's own settle resolves `finished`; a stall or a cancel grace ends the drain without one, and
            // awaiting it there is the hang this phase is bounded against.
            const result = settled ? await finished : undefined;
            if (stalled) {
                errored = true;
                yield { kind: "error", message: CURSOR_STALLED, code: "provider-outage" };
            } else if (sendError !== undefined) {
                errored = true;
                yield await codedError(sendError, await cursorSdk());
            } else if (result?.status === "error") {
                errored = true;
                yield { kind: "error", message: result.error?.message ?? "The Cursor turn failed." };
            }
            const usage = mapper.usage();
            if (usage !== undefined) {
                yield usage;
            }
        } finally {
            clearTimeout(stall);
            // One listener per phase; a plan turn runs two, so an unremoved one leaks into the next phase.
            unwatchAbort();
        }
        const captured = mapper.capture();
        return { errored: errored || captured.errored === true, planText: captured.planText };
    }

    return async function* cursorAgent(request: AgentRequest<CursorCredential>): AsyncGenerator<AgentEvent> {
        const sdk = await cursorSdk();
        if (sdk === undefined) {
            yield { kind: "error", message: CURSOR_SDK_MISSING };
            yield { kind: "done" };
            return;
        }
        const apiKey = request.credential.apiKey;
        if (apiKey === "") {
            // Reached only when a request is built by hand; planCursorTurn already refuses first with the same code.
            yield { kind: "error", message: "Connect your Cursor subscription in Sandbox ▸ Agent to run Cursor.", code: "subscription-required" };
            yield { kind: "done" };
            return;
        }

        // The SDK requires an explicit model with no default; the catalog is never empty, so this always resolves.
        const modelId = request.spec.model !== undefined && request.spec.model !== "" ? request.spec.model : (await deps.catalog.models()).default;
        const item = await deps.catalog.item(modelId);
        // Without the vendor record (persisted/seeded) the bare id is sent: an untranslatable effort isn't guessed.
        const selection: ModelSelection = item === undefined ? { id: modelId } : selectionFor(item, request.spec.effort);

        // Attachments ride the prompt as a file list; Cursor's read tool takes them off disk, like the OpenCode/Pi
        // runtimes.
        const { images, others } = splitAttachments(request.spec.attachments ?? []);
        const basePrompt = withFileNote(request.spec.prompt, [...images, ...others]);

        // One stream for the turn, two producers: the SDK's mapped deltas, and the custom tool handlers and hooks that
        // run inside Cursor's loop with no generator to yield from. They share it because a handler that parks on a
        // person is itself what stops the deltas, so a card waiting for the next one would never be shown — and the
        // handler holding the turn would never be answered.
        const queue = new EventQueue<PhaseItem>();
        const push = (event: AgentEvent): void => queue.push(event);

        // Rulebook axis "hooks" makes a hold park on a card, not refuse, while the hook process waits on the socket.
        // Built ahead of the options because the JS backend rides a custom tool and consults this gate from inside its
        // own handler, where no hook can reach it.
        const { gate, taint, release } = vendorTurnGate(request);

        const options: AgentOptions = {
            model: selection,
            apiKey,
            disallowedTools: [...TOOLS_WITHHELD],
            local: {
                cwd: request.spec.cwd,
                // mdm carries the command gate (cursor-hooks.ts); user is skipped, it also reads this daemon's Claude
                // settings.
                settingSources: ["mdm", "project"],
                customTools: cursorCustomTools(request, { gate, taint }, push),
            },
            mcpServers: cursorMcpServers(request),
        };

        let agent: SDKAgent | undefined;
        try {
            agent = request.spec.sessionId !== undefined ? await sdk.Agent.resume(request.spec.sessionId, options) : await sdk.Agent.create(options);
        } catch (error) {
            release();
            yield await codedError(error, sdk);
            yield { kind: "done" };
            return;
        }

        // Session id a follow-up resumes on, and the id the hook gate correlates a consult back to.
        yield { kind: "session", sessionId: agent.agentId };
        yield { kind: "init", model: modelId };

        const retire = deps.hooks.register({
            conversationId: agent.agentId,
            ...(request.tools.cliEnv !== undefined ? { cliEnv: request.tools.cliEnv } : {}),
            ...(request.spec.systemAppend !== undefined ? { systemAppend: request.spec.systemAppend } : {}),
            gate,
            push,
        });

        // This turn's one consumer of the steering queue; absent for a bench or benchmark run with no queue.
        const relay = request.spec.steering === undefined ? undefined : steeringRelay(request.spec.steering);

        // The SDK's local store marks a run finished only from inside the process that ran it, so a daemon killed
        // mid-run (an OOM kill, a restart) leaves that run RUNNING on disk, and every later send on the agent throws
        // "already has active run" for good. Turns on one conversation are serialized, so any run still open when a
        // resumed agent's first send goes out is that orphan: `force` expires it, the SDK's own recovery for exactly
        // this. Later phases of the same turn follow a run this process settled itself, and are sent plainly.
        let orphanPossible = request.spec.sessionId !== undefined;

        try {
            const live = agent;
            const send = async function* (prompt: string, planning: boolean): AsyncGenerator<AgentEvent, { errored: boolean; planText?: string }> {
                // Each phase borrows its own channel and closes it, so a message typed during a plan's approval pause
                // waits for the executing phase instead of being delivered to the run that already finished.
                const channel = relay?.();
                const force = orphanPossible;
                orphanPossible = false;
                try {
                    const outcome = yield* runPhase(live, request, queue, prompt, selection, planning, channel, force);
                    return { errored: outcome.errored, ...(outcome.planText !== undefined ? { planText: outcome.planText } : {}) };
                } finally {
                    channel?.close();
                }
            };

            yield* planMode(
                CURSOR,
                request,
                () => ({
                    // The preamble rides the prompt though mode:"plan" enforces read-only: it tells the model to end with a
                    // plan.
                    prompt: `${PLAN_PREAMBLE}${basePrompt}`,
                    async *plan(prompt) {
                        const outcome = yield* send(prompt, true);
                        // Session never changes across phases; reporting undefined here keeps the emulation's seed rather
                        // than reassigning it.
                        return { sessionId: undefined, planText: outcome.planText, errored: outcome.errored };
                    },
                    execute: () => send(EXECUTE_PROMPT, false),
                }),
                () => send(basePrompt, false),
            );
        } finally {
            // Order matters: retire, then release, then close; a consult between finds no turn, and is allowed.
            retire();
            release();
            agent.close();
        }
        yield { kind: "done" };
    };
};
