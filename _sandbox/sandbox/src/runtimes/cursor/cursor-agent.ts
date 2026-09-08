import type { AgentOptions, InteractionUpdate, ModelSelection, Run, SDKAgent, SendOptions } from "@cursor/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { whenAborted } from "../../abort.js";
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

export const createCursorAgent = (deps: CursorAgentDeps) => {
    // Forwards every mapped frame for one turn; the caller emits `done` once, since a plan turn runs two of these.
    // While planning, the assistant's prose is captured, not streamed, becoming the plan text.
    async function* runPhase(
        agent: SDKAgent,
        request: AgentRequest,
        prompt: string,
        selection: ModelSelection | undefined,
        planning: boolean,
    ): AsyncGenerator<AgentEvent, { errored: boolean; planText: string | undefined }> {
        const mapper = createCursorEventMapper(request.cwd, planning);
        const queue = new UpdateQueue();
        const options: SendOptions = {
            mode: modeFor(planning),
            ...(selection !== undefined ? { model: selection } : {}),
            onDelta: ({ update }) => queue.push(update),
        };

        let sendError: unknown;
        // Not awaited: frames arrive via onDelta while this resolves; awaiting first would buffer the turn's opening.
        const started: Promise<Run | undefined> = agent.send(prompt, options).catch((error: unknown) => {
            sendError = error;
            queue.close();
            return undefined;
        });

        // Stop cancels the run instead of abandoning it, so Cursor unwinds tool calls and the transcript ends resolved.
        const onAbort = (): void => {
            void started.then((handle) => handle?.cancel().catch(() => undefined));
            setTimeout(() => queue.close(), CANCEL_GRACE_MS).unref();
        };
        // A pre-pull Stop hits an aborted signal no listener catches; unwatched, send starts a run nothing can cancel.
        const unwatchAbort = whenAborted(request.signal, onAbort);

        // Closes the queue when the run itself finishes, ending the drain below.
        const finished = started.then(async (handle) => {
            if (handle === undefined) {
                return undefined;
            }
            const result = await handle.wait().catch((error: unknown) => {
                sendError = error;
                return undefined;
            });
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
            const result = await finished;
            if (sendError !== undefined) {
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

        const options: AgentOptions = {
            model: selection,
            apiKey,
            disallowedTools: [...TOOLS_WITHHELD],
            local: {
                cwd: request.cwd,
                // mdm carries the command gate (cursor-hooks.ts); user is skipped, it also reads this daemon's Claude
                // settings.
                settingSources: ["mdm", "project"],
                customTools: cursorCustomTools(request, push),
            },
            mcpServers: cursorMcpServers(request),
        };

        let agent: SDKAgent | undefined;
        try {
            agent = request.sessionId !== undefined ? await sdk.Agent.resume(request.sessionId, options) : await sdk.Agent.create(options);
        } catch (error) {
            yield await codedError(error, sdk);
            yield { kind: "done" };
            return;
        }

        // Session id a follow-up resumes on, and the id the hook gate correlates a consult back to.
        yield { kind: "session", sessionId: agent.agentId };
        yield { kind: "init", model: modelId };

        // Rulebook axis "hooks" makes a hold park on a card, not refuse, while the hook process waits on the socket.
        const { gate, release } = createTurnGate(request);
        const retire = deps.hooks.register({
            conversationId: agent.agentId,
            ...(request.cliEnv !== undefined ? { cliEnv: request.cliEnv } : {}),
            gate,
            push,
        });

        try {
            const live = agent;
            const send = async function* (prompt: string, planning: boolean): AsyncGenerator<AgentEvent, { errored: boolean; planText?: string }> {
                const phase = runPhase(live, request, prompt, selection, planning);
                let step = await phase.next();
                while (step.done !== true) {
                    yield step.value;
                    yield* flush();
                    step = await phase.next();
                }
                yield* flush();
                return { errored: step.value.errored, ...(step.value.planText !== undefined ? { planText: step.value.planText } : {}) };
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
