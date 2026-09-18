import type { AgentOptions, InteractionUpdate, ModelSelection, Run, SDKAgent, SendOptions } from "@cursor/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { whenAborted } from "../../abort.js";
import { type SteeringChannel, steeringRelay } from "../../agent/anchors/agent-steering.js";
import type { AgentRequest } from "../../agent/run/agent.js";
import { splitAttachments, withFileNote } from "../../agent/prompt/attachment-note.js";
import { EXECUTE_PROMPT, type ExecutePhase, PLAN_PREAMBLE, type PlanPhase, runPlanEmulation } from "../../agent/prompt/plan-emulation.js";
import { createTurnGate } from "../../guard/turn-gate.js";
import type { CursorCatalog } from "./cursor-catalog.js";
import { createCursorEventMapper } from "./cursor-events.js";
import type { CursorHookService } from "./cursor-hooks.js";
import { selectionFor } from "./cursor-models.js";
import { CURSOR_SDK_MISSING, cursorSdk } from "./cursor-sdk.js";
import { cursorCustomTools, cursorMcpServers, TOOLS_WITHHELD } from "./cursor-tools.js";

// Cursor provider adapter: same AgentRequest-in/AgentEvent-out seam as createCodexAgent/createGrokAgent/runPiAgent,
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
    if (error instanceof sdk.AgentNotFoundError || error instanceof sdk.UnknownAgentError) {
        // This machine lost the named agent (store cleared, a rebuild); client drops it, next send opens fresh.
        return { kind: "error", message, code: "session-not-found" };
    }
    if (error instanceof sdk.NetworkError) {
        return { kind: "error", message, code: "provider-outage" };
    }
    return { kind: "error", message };
};

// Callback-to-generator bridge: `onDelta` pushes, the generator yields, one producer and one consumer.
// No backpressure: the consuming HTTP stream drains fast enough that the model should never wait on a browser.
class UpdateQueue {
    private readonly items: InteractionUpdate[] = [];
    private wake: (() => void) | undefined;
    private closed = false;

    push(update: InteractionUpdate): void {
        this.items.push(update);
        this.wake?.();
    }

    close(): void {
        this.closed = true;
        this.wake?.();
    }

    async *drain(): AsyncGenerator<InteractionUpdate> {
        for (;;) {
            while (this.items.length > 0) {
                yield this.items.shift() as InteractionUpdate;
            }
            if (this.closed) {
                return;
            }
            await new Promise<void>((settle) => {
                this.wake = () => {
                    this.wake = undefined;
                    settle();
                };
            });
        }
    }
}

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
    // Forwards every mapped frame for one turn; the caller emits `done` once, since a plan turn runs two of these.
    // While planning, the assistant's prose is captured, not streamed, becoming the plan text.
    async function* runPhase(
        agent: SDKAgent,
        request: AgentRequest,
        prompt: string,
        selection: ModelSelection | undefined,
        planning: boolean,
        channel: SteeringChannel | undefined,
    ): AsyncGenerator<AgentEvent, { errored: boolean; planText: string | undefined }> {
        const mapper = createCursorEventMapper(request.cwd, planning);
        const queue = new UpdateQueue();
        let sawDelta = false;
        const options: SendOptions = {
            mode: modeFor(planning),
            ...(selection !== undefined ? { model: selection } : {}),
            onDelta: ({ update }) => {
                sawDelta = true;
                queue.push(update);
            },
        };

        let sendError: unknown;
        // Not awaited: frames arrive via onDelta while this resolves; awaiting first would buffer the turn's opening.
        const started: Promise<Run | undefined> = agent.send(prompt, options).catch((error: unknown) => {
            sendError = error;
            queue.close();
            return undefined;
        });

        // Covers both silences the SDK can hold a turn in: a `send` that never resolves, and a run that resolves and
        // then never deltas. Cancel is best-effort, so the queue closes on this timer rather than on the cancel.
        let stalled = false;
        const stall = setTimeout(() => {
            if (sawDelta) {
                return;
            }
            stalled = true;
            void started.then((handle) => handle?.cancel().catch(() => undefined));
            queue.close();
        }, FIRST_DELTA_MS);
        stall.unref();

        // Stop cancels the run instead of abandoning it, so Cursor unwinds tool calls and the transcript ends resolved.
        const onAbort = (): void => {
            void started.then((handle) => handle?.cancel().catch(() => undefined));
            setTimeout(() => queue.close(), CANCEL_GRACE_MS).unref();
        };
        // A pre-pull Stop hits an aborted signal no listener catches; unwatched, send starts a run nothing can cancel.
        const unwatchAbort = whenAborted(request.signal, onAbort);

        // Not awaited: it lives as long as this phase's channel, and the frames below are what the turn is waiting on.
        if (channel !== undefined) {
            void steerInto(started, channel, deps.logger);
        }

        // Closes the queue when the run itself finishes, ending the drain below.
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
            queue.close();
            return result;
        });

        let errored = false;
        try {
            for await (const update of queue.drain()) {
                for (const frame of mapper.map(update)) {
                    if (frame.kind === "error") {
                        errored = true;
                    }
                    yield frame;
                }
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

    return async function* cursorAgent(request: AgentRequest): AsyncGenerator<AgentEvent> {
        const sdk = await cursorSdk();
        if (sdk === undefined) {
            yield { kind: "error", message: CURSOR_SDK_MISSING };
            yield { kind: "done" };
            return;
        }
        const apiKey = request.cursorApiKey;
        if (apiKey === undefined || apiKey === "") {
            // Reached only when a request is built by hand; planCursorTurn already refuses first with the same code.
            yield { kind: "error", message: "Connect your Cursor subscription in Sandbox ▸ Agent to run Cursor.", code: "subscription-required" };
            yield { kind: "done" };
            return;
        }

        // The SDK requires an explicit model with no default; the catalog is never empty, so this always resolves.
        const modelId = request.model !== undefined && request.model !== "" ? request.model : (await deps.catalog.models()).default;
        const item = await deps.catalog.item(modelId);
        // Without the vendor record (persisted/seeded) the bare id is sent: an untranslatable effort isn't guessed.
        const selection: ModelSelection = item === undefined ? { id: modelId } : selectionFor(item, request.effort);

        // Attachments ride the prompt as a file list; Cursor's read tool takes them off disk, like the OpenCode/Pi
        // runtimes.
        const { images, others } = splitAttachments(request.attachments ?? []);
        const basePrompt = withFileNote(request.prompt, [...images, ...others]);

        // Custom tool handlers run inside Cursor's loop with no generator to yield from; they push frames here.
        const frames: AgentEvent[] = [];
        const push = (event: AgentEvent): void => {
            frames.push(event);
        };
        const flush = function* (): Generator<AgentEvent> {
            while (frames.length > 0) {
                yield frames.shift() as AgentEvent;
            }
        };

        // Rulebook axis "hooks" makes a hold park on a card, not refuse, while the hook process waits on the socket.
        // Built ahead of the options because the JS backend rides a custom tool and consults this gate from inside its
        // own handler, where no hook can reach it.
        const { gate, taint, release } = createTurnGate(request);

        const options: AgentOptions = {
            model: selection,
            apiKey,
            disallowedTools: [...TOOLS_WITHHELD],
            local: {
                cwd: request.cwd,
                // mdm carries the command gate (cursor-hooks.ts); user is skipped, it also reads this daemon's Claude
                // settings.
                settingSources: ["mdm", "project"],
                customTools: cursorCustomTools(request, { gate, taint }, push),
            },
            mcpServers: cursorMcpServers(request),
        };

        let agent: SDKAgent | undefined;
        try {
            agent = request.sessionId !== undefined ? await sdk.Agent.resume(request.sessionId, options) : await sdk.Agent.create(options);
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
            ...(request.cliEnv !== undefined ? { cliEnv: request.cliEnv } : {}),
            ...(request.systemAppend !== undefined ? { systemAppend: request.systemAppend } : {}),
            gate,
            push,
        });

        // This turn's one consumer of the steering queue; absent for a bench or benchmark run with no queue.
        const relay = request.steering === undefined ? undefined : steeringRelay(request.steering);

        try {
            const live = agent;
            const send = async function* (prompt: string, planning: boolean): AsyncGenerator<AgentEvent, { errored: boolean; planText?: string }> {
                // Each phase borrows its own channel and closes it, so a message typed during a plan's approval pause
                // waits for the executing phase instead of being delivered to the run that already finished.
                const channel = relay?.();
                const phase = runPhase(live, request, prompt, selection, planning, channel);
                try {
                    let step = await phase.next();
                    while (step.done !== true) {
                        yield step.value;
                        yield* flush();
                        step = await phase.next();
                    }
                    yield* flush();
                    return { errored: step.value.errored, ...(step.value.planText !== undefined ? { planText: step.value.planText } : {}) };
                } finally {
                    channel?.close();
                }
            };

            if (request.permissionMode === "plan") {
                const planPhase: PlanPhase = async function* (prompt) {
                    const outcome = yield* send(prompt, true);
                    // Session never changes across phases; reporting undefined here keeps the emulation's seed rather
                    // than reassigning it.
                    return { sessionId: undefined, planText: outcome.planText, errored: outcome.errored };
                };
                const executePhase: ExecutePhase = async function* () {
                    yield* send(EXECUTE_PROMPT, false);
                };
                // The preamble rides the prompt though mode:"plan" enforces read-only: it tells the model to end with a
                // plan.
                yield* runPlanEmulation(request.signal, `${PLAN_PREAMBLE}${basePrompt}`, request.sessionId, planPhase, executePhase);
            } else {
                yield* send(basePrompt, false);
            }
        } finally {
            // Order matters: retire, then release, then close; a consult between finds no turn, and is allowed.
            retire();
            release();
            agent.close();
        }
        yield { kind: "done" };
    };
};
