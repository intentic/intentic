import type { AgentOptions, InteractionUpdate, ModelSelection, Run, SDKAgent, SendOptions } from "@cursor/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import type { AgentRequest } from "../agent/agent.js";
import { splitAttachments, withFileNote } from "../agent/attachment-note.js";
import { EXECUTE_PROMPT, type ExecutePhase, PLAN_PREAMBLE, type PlanPhase, runPlanEmulation } from "../agent/plan-emulation.js";
import { createTurnGate } from "../guard/turn-gate.js";
import type { CursorCatalog } from "./cursor-catalog.js";
import { createCursorEventMapper } from "./cursor-events.js";
import type { CursorHookService } from "./cursor-hooks.js";
import { selectionFor } from "./cursor-models.js";
import { CURSOR_SDK_MISSING, cursorSdk } from "./cursor-sdk.js";
import { cursorCustomTools, cursorMcpServers, TOOLS_WITHHELD } from "./cursor-tools.js";

/* THE CURSOR PROVIDER ADAPTER: the same seam as runAgent / createCodexAgent / createGrokAgent / runPiAgent —
 * AgentRequest in, AgentEvent frames out — over `@cursor/sdk`'s local agent runtime. Provider differences stay
 * inside this file; the wire contract, the routes and the UI are shared.
 *
 * IN-PROCESS, WHICH IS THE ONE THING THAT MAKES IT DIFFERENT FROM ITS NEIGHBOURS. Codex spawns an app-server,
 * OpenCode talks to a warm HTTP server, Pi spawns a CLI per turn; this runs Cursor's whole loop inside the
 * daemon. Two consequences, both stated in the capability record and both visible here: there is no child
 * process to put in a mount namespace (hence `isolation: "cwd"`, and the turn is told where its worktree is),
 * and the daemon's own functions can BE tools (hence a real question card, see cursor-tools.ts).
 *
 * TWO STREAMS, ONE READ. The SDK exposes a run's progress twice — `run.stream()` yields whole messages,
 * `send({ onDelta })` yields incremental updates — and they overlap, so reading both would double every card.
 * The delta stream is the strictly richer of the two and is the one consumed; the run handle supplies only what
 * a delta stream cannot have an opinion about: whether the whole thing ended well, and how to cancel it.
 *
 * PLAN MODE IS CURSOR'S OWN. The shared two-phase emulation still runs the approval loop (Cursor publishes no
 * ExitPlanMode equivalent for the model to call), but the planning phase runs under `mode: "plan"`, a posture
 * the VENDOR enforces, rather than under a prompt that asks the model not to touch anything. Same card, same
 * approval, a genuinely read-only first half. */

export interface CursorAgentDeps {
    readonly catalog: CursorCatalog;
    readonly hooks: CursorHookService;
    readonly logger: Logger;
}

/* How long a turn waits for the SDK to acknowledge a cancel before the frames stop being forwarded.
 *
 * A cancel is a request, not a kill: Cursor tears down its own tool calls, which for a running command means
 * waiting on the process. Five seconds is long enough for that to happen in order (so the transcript ends with
 * the tool card resolved rather than mid-flight) and short enough that a Stop button feels like one. */
const CANCEL_GRACE_MS = 5_000;

// Everything the SDK can throw that means "your plan said no" or "your key is dead", answered as the coded
// frames the daemon's auto-resume and reconnect paths already key off. Matched by the exported CLASSES rather
// than by message text: the classes are public API and the sentences are not.
const codedError = async (error: unknown, sdk: Awaited<ReturnType<typeof cursorSdk>>): Promise<Extract<AgentEvent, { kind: "error" }>> => {
    const message = error instanceof Error && error.message !== "" ? error.message : "The Cursor turn failed.";
    if (sdk === undefined) {
        return { kind: "error", message };
    }
    if (error instanceof sdk.RateLimitError) {
        return { kind: "error", message, code: "rate_limit" };
    }
    if (error instanceof sdk.AuthenticationError) {
        // Not `subscription-required`: an account IS connected, its key has simply stopped being accepted, and
        // the fix is a fresh sign-in on the same row rather than connecting a first account.
        return { kind: "error", message: `${message} Connect your Cursor account again in Sandbox ▸ Agent.` };
    }
    if (error instanceof sdk.AgentBusyError) {
        return { kind: "error", message, code: "agent-busy" };
    }
    if (error instanceof sdk.AgentNotFoundError || error instanceof sdk.UnknownAgentError) {
        // The conversation names a Cursor agent this machine no longer has (its store cleared, a rebuild). The
        // client drops the dead session id and the next send opens a fresh one, which is the same self-heal
        // every other runtime gets from this code.
        return { kind: "error", message, code: "session-not-found" };
    }
    if (error instanceof sdk.NetworkError) {
        return { kind: "error", message, code: "provider-outage" };
    }
    return { kind: "error", message };
};

/* THE CALLBACK-TO-GENERATOR BRIDGE. `onDelta` pushes and this adapter yields, so the updates are queued and
 * the consumer is woken; the same shape pi-agent uses for its pull-per-event transport, kept minimal here
 * because there is exactly one producer and one consumer.
 *
 * Backpressure is deliberately absent. The producer is Cursor's own loop and the consumer is an HTTP stream
 * that drains as fast as the socket allows; making the model wait on a browser would be the wrong trade, and
 * the queue's ceiling is one turn's worth of updates. */
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

// The posture a phase runs in. Cursor's `plan` is read-only by the runtime's own enforcement; `agent` is the
// full toolbox. Everything else this repo can ask for collapses onto `agent`, because the finer postures are
// per-tool approvals and this runtime's answer to those is the command rulebook, not a mode.
const modeFor = (planning: boolean): "plan" | "agent" => (planning ? "plan" : "agent");

export const createCursorAgent = (deps: CursorAgentDeps) => {
    /* One turn's worth of work against a live SDK agent: send the prompt, forward every mapped frame, and
     * settle. Does NOT emit the terminal `done`, the caller does once the whole turn (plan phases included)
     * has settled — the pi-agent contract, for the same reason: a plan turn is two of these.
     *
     * `holdText` makes it a PLANNING phase: the assistant's prose is captured instead of streamed, because
     * that text is the plan the card is about to show. */
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
        // The send is started but NOT awaited here: its promise resolves with the run handle, while the frames
        // that handle describes are already arriving on `onDelta`. Awaiting first would buffer the whole
        // opening of the turn behind a round trip.
        const started: Promise<Run | undefined> = agent.send(prompt, options).catch((error: unknown) => {
            sendError = error;
            queue.close();
            return undefined;
        });

        // A Stop cancels the run rather than abandoning it, so Cursor unwinds its own tool calls and the
        // transcript ends with them resolved instead of frozen mid-flight.
        const onAbort = (): void => {
            void started.then((handle) => handle?.cancel().catch(() => undefined));
            setTimeout(() => queue.close(), CANCEL_GRACE_MS).unref();
        };
        request.signal.addEventListener("abort", onAbort, { once: true });

        // Close the queue when the run itself finishes, which is what ends the drain below.
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
            // One listener per phase, and a plan turn runs two, so an un-removed one would still be holding a
            // reference to the finished run when the next phase's Stop fires.
            request.signal.removeEventListener("abort", onAbort);
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
            // Reached only when a caller builds a request by hand: planCursorTurn refuses first, with the same
            // code, so the connect gate is what the user actually meets.
            yield { kind: "error", message: "Connect your Cursor subscription in Sandbox ▸ Agent to run Cursor.", code: "subscription-required" };
            yield { kind: "done" };
            return;
        }

        /* The model, resolved to something CONCRETE before anything is sent. The SDK requires a model for a
         * local agent and has no default of its own, so an unresolved id is not a soft failure here the way it
         * is on runtimes with a fallback — it is a turn that cannot start. The catalog is never empty, so this
         * always lands on something. */
        const modelId = request.model !== undefined && request.model !== "" ? request.model : (await deps.catalog.models()).default;
        const item = await deps.catalog.item(modelId);
        // With the vendor's record in hand the effort tier can be translated into this model's own parameters;
        // without it (a persisted or seeded rung, where only ids are known) the bare id is sent, which is
        // correct rather than degraded: an effort we cannot translate is one we must not guess at.
        const selection: ModelSelection = item === undefined ? { id: modelId } : selectionFor(item, request.effort);

        // Attachments ride the prompt as a file list: Cursor's read tool takes them off disk, and pointing at
        // them is what every non-native-attachment runtime here does (the OpenCode/Pi shape).
        const { images, others } = splitAttachments(request.attachments ?? []);
        const basePrompt = withFileNote(request.prompt, [...images, ...others]);

        /* The turn's own frame sink, built BEFORE the options that close over it. A custom tool's handler runs
         * inside Cursor's loop, where there is no generator to yield from, so it pushes here and the phase loop
         * flushes on its next turn — which is how a question card raised deep inside a tool call reaches the
         * conversation that asked for it. */
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
                /* The layers Cursor loads its own configuration from, and the two omissions are the point.
                 *
                 * "mdm" is /etc/cursor/hooks.json, which this daemon owns and writes the command gate into
                 * (cursor-hooks.ts) — without it the owner's command rules do not apply here at all.
                 * "project" is the workspace's own .cursor rules, skills and AGENTS.md, which belong to the
                 * user and should be in force.
                 *
                 * "user" is left out because Cursor reads ~/.claude/settings.json under that layer as well as
                 * ~/.cursor: this daemon WRITES that Claude settings file, for a different runtime, and its
                 * hook scripts speak Claude Code's protocol. Loading them here would hand Cursor's payloads to
                 * scripts written for someone else's. "team" and "plugins" are cloud-resolved and off by
                 * default. */
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

        // The session id a follow-up message resumes on, and the id the hook gate correlates a consult back to.
        yield { kind: "session", sessionId: agent.agentId };
        yield { kind: "init", model: modelId };

        /* The gate and the taint bit, minted from the request exactly as every other vendor runtime mints
         * them. Its shape is DERIVED from this pair's `rulebook` axis, which for Cursor is "hooks", so a hold
         * genuinely parks on a card here rather than refusing — the hook process waiting on the socket is what
         * Cursor is blocked on meanwhile (cursor-hooks.ts). */
        const { gate, release } = createTurnGate(request);
        const retire = deps.hooks.register({ conversationId: agent.agentId, gate, push });

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
                    // The session never changes across phases here: one SDK agent serves the whole turn, and
                    // its id was already announced. Reported as undefined so the emulation keeps its seed.
                    return { sessionId: undefined, planText: outcome.planText, errored: outcome.errored };
                };
                const executePhase: ExecutePhase = async function* () {
                    yield* send(EXECUTE_PROMPT, false);
                };
                // The preamble still rides the planning prompt even though `mode: "plan"` already enforces
                // read-only: it is what tells the model to END with the plan, which is the text the card shows.
                yield* runPlanEmulation(request.signal, `${PLAN_PREAMBLE}${basePrompt}`, request.sessionId, planPhase, executePhase);
            } else {
                yield* send(basePrompt, false);
            }
        } finally {
            // Order matters: stop answering gate consults for this agent id first, then drop the conversation's
            // published taint bit, then let the runtime go. A consult arriving between the last two would find
            // no turn and be allowed, which is the state a finished turn should be in anyway.
            retire();
            release();
            agent.close();
        }
        yield { kind: "done" };
    };
};
