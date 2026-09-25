import { basename } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { Event, FilePartInput, ToolPart } from "@opencode-ai/sdk";
import { type AgentEvent, OPENCODE } from "@intentic/sandbox-contract";
import { whenAborted } from "@intentic/base/async";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import { withFileNote } from "../../agent/prompt/attachment-note.js";
import { loadAttachments } from "../decorators/attachment-images.js";
import { type EmulatedPlan, EXECUTE_PROMPT, PLAN_PREAMBLE, planMode } from "../decorators/plan-mode.js";
import { beforeDeadline, DEFAULT_TURN_TIMEOUTS, EXPIRED, type TurnTimeouts, turnWatchdog } from "../decorators/turn-watchdog.js";
import { isRateLimited, vendorFailureFrame, type VendorRule } from "../decorators/vendor-errors.js";
import { isContextOverflowText } from "../../agent/providers/failure-sentences.js";
import { contextOverflowFrame } from "../../agent/run/error-frames.js";
import { displayNameOf, editDiffContent, toolLocations, toolTarget } from "../../agent/tools/tool-calls.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import { planPhaseOf, toolCallOpened, type TurnCapture, usageTotals } from "../decorators/vendor-events.js";
import { vendorTurnGate } from "../decorators/vendor-gate.js";
import { isChatModel, parseModelSuggestions } from "./xai-models.js";
import { openCodeBackendLabel, type OpenCodeService, registerSessionGate, releaseSessionGate } from "./opencode.js";

// The OpenCode loop Grok and Gemini both run on: AgentRequest in, AgentEvent frames out, over one shared `opencode serve`.

// The xAI provider id in OpenCode / models.dev, and the default backend for a turn that names none.
const XAI = "xai";

// One OpenCode turn: the runner creates or resumes its session and yields its events; injected so tests drive a fake stream.
export interface OpenCodeTurn {
    readonly prompt: string;
    readonly sessionId?: string;
    readonly cwd: string;
    readonly model?: string;
    // OpenCode's provider id to drive this turn on; absent means xAI. Per-turn: one shared opencode serve carries both
    // providers.
    readonly provider?: string;
    // The built-in OpenCode agent: "plan" is read-only (proposes), "build" executes.
    readonly agent: "plan" | "build";
    // Command-rulebook gate for this turn, registered against the session id once it exists; absent means every
    // permission gets the standing yes.
    readonly gate?: CommandGuard;
    // Standing instructions appended via OpenCode's `system` field (added to, not replacing, OpenCode's own prompt);
    // per message, not per session.
    readonly system?: string;
    // Images already read off disk, sent as native parts rather than named as paths in the prompt; read in the adapter
    // so an unreadable one falls back to a prompt note.
    readonly images?: readonly FilePartInput[];
    readonly signal: AbortSignal;
}
export type OpenCodeRunner = (turn: OpenCodeTurn) => AsyncIterable<Event>;

// The session an event belongs to, for filtering the global stream down to this turn's session.
const eventSessionId = (event: Event): string | undefined => {
    switch (event.type) {
        case "session.created":
            return event.properties.info.id;
        case "session.idle":
        case "session.error":
        case "todo.updated":
        case "permission.updated":
        // Counts as watchdog liveness; a model can think for minutes before its first token. Also where a retry
        // announces itself (see streamTurn).
        case "session.status":
            return event.properties.sessionID;
        case "message.part.updated":
            return event.properties.part.sessionID;
        case "message.updated":
            return event.properties.info.sessionID;
        default:
            return undefined;
    }
};

// How long the stream gets to say hello before the turn proceeds without proof it's listening; short compared to the
// inactivity watchdog.
const CONNECT_MS = 5_000;

// A closed stream without session.idle/session.error means the shared opencode serve went away, not a finished turn;
// throws, except when this turn's own abort is what closed it (returns quietly).
const refuseEarlyClose = (turn: OpenCodeTurn): void => {
    if (turn.signal.aborted) {
        return;
    }
    throw new Error(`${openCodeBackendLabel(turn.provider ?? XAI)} stopped sending events before the turn ended.`);
};

// Production runner: creates/resumes the session on the shared OpenCode client, fires the prompt, and yields the
// session's events off the global SSE stream. No event for this session within the inactivity window is a stuck turn,
// aborted; `timeouts` is injectable for tests.
export const createOpenCodeRunner = (openCode: OpenCodeService, timeouts: TurnTimeouts = DEFAULT_TURN_TIMEOUTS): OpenCodeRunner =>
    async function* (turn) {
        const c = await openCode.client();
        // Subscribes before creating/prompting so session.created and early events aren't missed; scoped to this turn's
        // directory, since an unscoped stream carries no session events (see subscribeEvents in opencode.ts).
        const sse = await openCode.events(turn.cwd);
        // Registers this turn's directory for delegation watching (idempotent); an isolated turn works in a worktree
        // the boot doesn't know about.
        await openCode.watch(turn.cwd);
        // `subscribe()` is lazy; the HTTP request fires only on first read, so it must happen before the session is
        // created or `session.created` is missed. The first read is awaited here, bounded by CONNECT_MS, and its result
        // is kept for the loop rather than dropped.
        const iterator: AsyncIterator<Event> = sse.stream[Symbol.asyncIterator]();
        let pending = iterator.next();
        const hello = await Promise.race([pending, new Promise<"unopened">((resolve) => setTimeout(() => resolve("unopened"), CONNECT_MS).unref())]);
        // Consumed here only if it resolved; otherwise the same promise is still what the loop first awaits.
        const buffered = hello === "unopened" || hello.done ? undefined : hello.value;
        if (buffered !== undefined) {
            pending = iterator.next();
        }
        let sessionId = turn.sessionId;
        if (sessionId === undefined) {
            // Named on creation so OpenCode skips auto-titling (an extra model call per unnamed session); the title
            // string itself is unused.
            const created = await c.session.create({ query: { directory: turn.cwd }, body: { title: `intentic conversation` } });
            sessionId = created.data?.id;
            if (sessionId === undefined) {
                throw new Error("OpenCode did not return a session id");
            }
        }
        // Registered only once the session id exists: a signal already aborted before this point never fires a listener
        // added later, so the session would run to completion while the UI shows it stopped.
        // allow(silent-catch): a stop OpenCode refuses leaves the turn to end on its own events or the watchdog
        whenAborted(turn.signal, () => void c.session.abort({ path: { id: sessionId } }).catch(() => {}));
        if (turn.gate !== undefined) {
            registerSessionGate(sessionId, turn.gate);
        }
        // Fires the prompt on the resolved session for a model id (empty means let OpenCode choose); reused by the
        // self-heal to re-prompt with a corrected model.
        const sendPrompt = (modelId: string | undefined): ReturnType<typeof c.session.promptAsync> =>
            c.session.promptAsync({
                path: { id: sessionId },
                query: { directory: turn.cwd },
                body: {
                    agent: turn.agent,
                    ...(modelId !== undefined && modelId !== "" ? { model: { providerID: turn.provider ?? XAI, modelID: modelId } } : {}),
                    ...(turn.system !== undefined ? { system: turn.system } : {}),
                    // Images precede the text part.
                    parts: [...(turn.images ?? []), { type: "text", text: turn.prompt }],
                },
            });
        // One self-heal attempt per turn: xAI names the account's valid models when it rejects a stale/renamed id.
        let retried = false;
        // After a self-heal re-prompt, a lingering idle from the failed prompt is ignored until the retry's first real
        // event proves it started.
        let awaitingRetryStart = false;
        // The self-heal is xAI-specific: the rejection wording and the corrected catalog both come from xAI. Gemini's
        // catalog comes off the translator and needs no rescue.
        const selfHeals = (turn.provider ?? XAI) === XAI;
        // xAI rejects a stale/renamed model id by rejecting promptAsync (thrown), not via a session.error event, so the
        // in-loop self-heal below never sees it; healed here the same way. No events stream on rejection, so no stale
        // idle to skip.
        try {
            await sendPrompt(turn.model);
        } catch (error) {
            const message = errorMessage(error);
            const suggestions = selfHeals && MODEL_INVALID.test(message) ? parseModelSuggestions(message).filter(isChatModel) : [];
            if (suggestions[0] === undefined) {
                throw error;
            }
            retried = true;
            await openCode.recordModels(suggestions);
            await sendPrompt(suggestions[0]);
        }
        // Drives the iterator manually so each read can race the watchdog (`for await` can't); closed on exit since it's
        // per-turn. Inactivity advances only on this session's events; the turn deadline is a hard backstop.
        const clock = turnWatchdog(timeouts);
        // The event the connect handshake already pulled off the stream, replayed as this loop's first read.
        let held = buffered;
        try {
            for (;;) {
                const next = pending;
                let event: Event;
                if (held !== undefined) {
                    event = held;
                    held = undefined;
                } else {
                    const result = await beforeDeadline(next, clock);
                    if (result === EXPIRED) {
                        next.catch(() => {}); // allow(silent-catch): the abandoned read lost to the deadline, whose error is the answer
                        // allow(silent-catch): the turn already ends on the deadline; a session that will not abort changes nothing
                        await c.session.abort({ path: { id: sessionId } }).catch(() => {});
                        throw new Error(`${openCodeBackendLabel(turn.provider ?? XAI)} turn timed out waiting for OpenCode: ${clock.expiry()}.`);
                    }
                    if (result.done) {
                        // Stream closed without the turn ending; refuseEarlyClose throws unless this turn's own abort
                        // caused it.
                        refuseEarlyClose(turn);
                        return;
                    }
                    event = result.value;
                    pending = iterator.next();
                }
                if (eventSessionId(event) !== sessionId) {
                    continue;
                }
                clock.touch();
                // OpenCode announces an in-turn retry wait once, with the instant of the next attempt; the inactivity
                // deadline moves past that instant so a long backoff isn't read as a hang, still bounded by the hard
                // turn cap.
                if (event.type === "session.status" && event.properties.status.type === "retry") {
                    clock.extendPast(event.properties.status.next);
                }
                // Self-heals a stale/renamed model by recording xAI's named alternatives and re-prompting the same
                // session once; nothing streams before a model-not-found rejection, so nothing is duplicated. A second
                // failure falls through as a real error.
                if (event.type === "session.error" && !retried && selfHeals) {
                    const message = errorText(event.properties.error);
                    const suggestions = MODEL_INVALID.test(message) ? parseModelSuggestions(message).filter(isChatModel) : [];
                    if (suggestions[0] !== undefined) {
                        retried = true;
                        awaitingRetryStart = true;
                        await openCode.recordModels(suggestions);
                        await sendPrompt(suggestions[0]);
                        continue;
                    }
                }
                if (awaitingRetryStart) {
                    // Drops a stale idle from the failed prompt; any other event means the corrected turn is under way.
                    if (event.type === "session.idle") {
                        continue;
                    }
                    awaitingRetryStart = false;
                }
                yield event;
                if (event.type === "session.idle" || event.type === "session.error") {
                    return;
                }
            }
        } finally {
            // allow(silent-catch): closing a stream that already failed has nothing left to report
            await iterator.return?.().catch(() => {});
            // The gate dies with its phase; a later permission belongs to no session judging it and gets the standing
            // yes (opencode.ts answerPermission).
            releaseSessionGate(sessionId);
        }
    };

// Flattens an OpenCode session error onto a message (every NamedError carries data.message).
const errorText = (error: unknown): string => {
    const named = error as { data?: { message?: string }; name?: string } | undefined;
    return named?.data?.message ?? named?.name ?? "agent error";
};

// xAI surfaces an unknown/retired model id as a "model not found" error naming valid alternatives; tagged so the client
// reloads the catalog and drops the bad pinned model.
const MODEL_INVALID = /model not found|does not exist|no such model|did you mean/i;

// How OpenCode's failure sentences are coded, in this order: a model xAI rejected, then a spent allowance, which gets a
// retry-later notice instead of a Continue that would just re-fail, then a session past the model's window.
const OPENCODE_FAILURES: readonly VendorRule[] = [
    [(message) => MODEL_INVALID.test(message), "grok-model-invalid"],
    [isRateLimited, "rate_limit"],
    [isContextOverflowText, "context-overflow"],
];

// A session error as its frame. OpenCode names an overflow its own compaction could not clear, in whatever words the
// provider used, so the name decides before the sentence rules do.
const sessionErrorFrame = (error: unknown): AgentEvent => {
    const message = errorText(error);
    return (error as { name?: string } | undefined)?.name === "ContextOverflowError"
        ? contextOverflowFrame(message)
        : vendorFailureFrame({ kind: "error", message }, OPENCODE_FAILURES);
};

// completed | error: an edit/write derives its diff from the final input; otherwise the tool's own output/error is
// used. A call first seen here arrives as one whole tool_call with its final status.
const finishedToolCall = (
    part: ToolPart,
    name: string,
    state: Extract<ToolPart["state"], { status: "completed" | "error" }>,
    cwd: string,
    first: boolean,
): AgentEvent => {
    const failed = state.status === "error";
    const diff = failed ? undefined : editDiffContent(name, state.input, cwd);
    const content = [diff ?? { type: "text" as const, text: failed ? state.error : state.output }];
    const status = failed ? ("failed" as const) : ("completed" as const);
    return first
        ? toolCallOpened({ id: part.callID, name, status, target: toolTarget(state.input), locations: toolLocations(state.input, cwd), content })
        : { kind: "tool_call_update", id: part.callID, status, content };
};

// Frames for one tool part, kept out of streamTurn's event walk. `started` is the set of callIDs that already opened a
// card, telling a first announcement from a later update.
async function* toolPartFrames(part: ToolPart, cwd: string, started: Set<string>): AsyncGenerator<AgentEvent> {
    const name = displayNameOf(part.tool);
    const state = part.state;
    // `pending` is skipped: OpenCode is still streaming input args, so target/locations would read as partial.
    if (state.status === "pending") {
        return;
    }
    const first = !started.has(part.callID);
    if (first) {
        started.add(part.callID);
    }
    if (state.status === "running") {
        if (first) {
            yield toolCallOpened({ id: part.callID, name, target: toolTarget(state.input), locations: toolLocations(state.input, cwd) });
        }
        return;
    }
    yield finishedToolCall(part, name, state, cwd, first);
}

// Normalizes one turn's OpenCode Event stream onto AgentEvents, returning what it captured (the plan phase reads this
// off `yield*`). `holdText` accumulates text into one `plan` frame instead of streaming deltas; ends on session.idle
// without emitting the terminal `done`.
async function* streamTurn(
    events: AsyncIterable<Event>,
    cwd: string,
    holdText = false,
    resumedSessionId?: string,
): AsyncGenerator<AgentEvent, TurnCapture> {
    const capture: TurnCapture = resumedSessionId !== undefined ? { sessionId: resumedSessionId } : {};
    // Per-part emitted text length, so each message.part.updated yields only the new suffix.
    const emitted = new Map<string, number>();
    // callIDs that have already emitted their opening tool_call frame, so later states ride tool_call_update instead of
    // repeating it.
    const started = new Set<string>();
    // Token/cost per assistant message, keyed by id (an agentic turn has several); latest snapshot wins, summed once at
    // idle.
    const usage = usageTotals();
    // Message id to role, since a text part carries no role itself; OpenCode broadcasts the user's echoed prompt on the
    // same stream, so without this it would leak into planText/delta.
    const roleOf = new Map<string, "user" | "assistant">();

    for await (const event of events) {
        if (event.type === "session.created") {
            capture.sessionId = event.properties.info.id;
            yield { kind: "session", sessionId: event.properties.info.id };
        } else if (event.type === "message.part.updated") {
            const part = event.properties.part;
            // Only assistant text is the answer/plan; a user part (the echoed prompt) is skipped, and an unknown role
            // is treated as assistant so early text isn't dropped.
            if (part.type === "text" && roleOf.get(part.messageID) !== "user") {
                const prev = emitted.get(part.id) ?? 0;
                // A snapshot no longer than what's already emitted carries no new suffix.
                if (part.text.length <= prev) {
                    continue;
                }
                const slice = part.text.slice(prev);
                emitted.set(part.id, part.text.length);
                if (holdText) {
                    capture.planText = (capture.planText ?? "") + slice;
                } else {
                    yield { kind: "delta", text: slice };
                }
            } else if (part.type === "reasoning") {
                const prev = emitted.get(part.id) ?? 0;
                if (part.text.length > prev) {
                    yield { kind: "thinking", text: part.text.slice(prev) };
                    emitted.set(part.id, part.text.length);
                }
            } else if (part.type === "tool" && part.tool !== "todowrite") {
                yield* toolPartFrames(part, cwd, started);
            }
        } else if (event.type === "todo.updated") {
            yield {
                kind: "todos",
                items: event.properties.todos.map((todo) => ({
                    content: todo.content,
                    status:
                        todo.status === "in_progress"
                            ? ("in_progress" as const)
                            : todo.status === "completed"
                              ? ("completed" as const)
                              : ("pending" as const),
                })),
            };
        } else if (event.type === "message.updated") {
            const info = event.properties.info;
            // Attributes this message's role so its text parts are captured (assistant) or skipped (user) above.
            roleOf.set(info.id, info.role);
            if (info.role === "assistant") {
                usage.add(
                    {
                        inputTokens: info.tokens.input,
                        outputTokens: info.tokens.output,
                        cacheReadTokens: info.tokens.cache.read,
                        cacheCreationTokens: info.tokens.cache.write,
                        costUsd: info.cost,
                    },
                    info.id,
                );
            }
        } else if (event.type === "session.status" && event.properties.status.type === "retry") {
            // Surfaces an in-turn provider retry so the chat shows a wait rather than an apparent hang; `status: 429`
            // lets the UI say it's rate-limiting rather than a dead turn. No maxAttempts: OpenCode names none, so none
            // is invented.
            const status = event.properties.status;
            yield {
                kind: "provider_retry",
                attempt: status.attempt,
                nextAttemptAt: status.next,
                ...(isRateLimited(status.message) ? { status: 429 } : {}),
            };
        } else if (event.type === "session.error") {
            yield sessionErrorFrame(event.properties.error);
            capture.errored = true;
            // Terminal: OpenCode doesn't reliably emit session.idle after an error, so ending here is what lets the
            // caller reach `done`.
            return capture;
        } else if (event.type === "session.idle") {
            const total = usage.frame();
            if (total !== undefined) {
                yield total;
            }
            return capture;
        }
    }
    return capture;
}

// The turn one OpenCode message runs as. Every message carries the same standing instructions, since a plan's two phases
// are two messages of one turn and the execute phase must not drop them.
const openCodeTurnOf =
    (request: AgentRequest, provider: string, gate: CommandGuard) =>
    (message: {
        readonly prompt: string;
        readonly images: readonly FilePartInput[];
        readonly sessionId: string | undefined;
        readonly agent: OpenCodeTurn["agent"];
    }): OpenCodeTurn => ({
        prompt: message.prompt,
        ...(message.images.length > 0 ? { images: message.images } : {}),
        ...(message.sessionId !== undefined ? { sessionId: message.sessionId } : {}),
        cwd: request.spec.cwd,
        ...(request.spec.model !== undefined ? { model: request.spec.model } : {}),
        provider,
        agent: message.agent,
        gate,
        ...(request.spec.systemAppend !== undefined ? { system: request.spec.systemAppend } : {}),
        signal: request.signal,
    });

// Plan flow over the shared skeleton: a read-only turn on the `plan` agent whose text becomes the plan, then execution on
// `build` resumed on the same session. Pictures ride the first planning message only; every later message resumes the
// session whose history already holds them. No `question` frames: the capability row says `questions: false`.
const openCodePlan = (
    request: AgentRequest,
    runner: OpenCodeRunner,
    turnOf: ReturnType<typeof openCodeTurnOf>,
    prompt: string,
    firstImages: readonly FilePartInput[],
): EmulatedPlan => {
    let images = firstImages;
    return {
        prompt: PLAN_PREAMBLE + prompt,
        async *plan(phasePrompt, sessionId) {
            const capture = yield* streamTurn(
                runner(turnOf({ prompt: phasePrompt, images, sessionId, agent: "plan" })),
                request.spec.cwd,
                true,
                sessionId,
            );
            images = [];
            return planPhaseOf(capture);
        },
        execute: (sessionId) => streamTurn(runner(turnOf({ prompt: EXECUTE_PROMPT, images: [], sessionId, agent: "build" })), request.spec.cwd),
    };
};

// A provider's loop on OpenCode's `provider` backend; capability limits are declared in the contract's agent-catalog.ts.
export const createOpenCodeAgent = (runner: OpenCodeRunner, provider: string = XAI) =>
    async function* runOpenCodeAgent(request: AgentRequest<ContainerCredential>): AsyncGenerator<AgentEvent> {
        // Pictures go to the model as pictures, base64 data URLs since the server is reached over HTTP; everything else,
        // including an unreadable picture, is named in the prompt for the read tool.
        const attached = await loadAttachments(request.spec, true);
        const images: FilePartInput[] = attached.images.map((image) => ({
            type: "file",
            mime: image.mimeType,
            filename: basename(image.path),
            url: `data:${image.mimeType};base64,${image.data}`,
        }));
        const prompt = withFileNote(request.spec.prompt, [...attached.files, ...attached.unread]);
        // Turn's safety wiring (guard/turn-gate.ts): rulebook answered over OpenCode's permission channel. `canPark:
        // false`: the watchdog aborts a turn with no session event in two minutes, so a paused permission would be read
        // as a hang; a hold is delivered as a refusal instead, and the capability record says `rulebook:
        // "refuse-only"`.
        const { gate, release } = vendorTurnGate(request);
        const turnOf = openCodeTurnOf(request, provider, gate);
        const turn = planMode(
            OPENCODE,
            request,
            () => openCodePlan(request, runner, turnOf, prompt, images),
            () => streamTurn(runner(turnOf({ prompt, images, sessionId: request.spec.sessionId, agent: "build" })), request.spec.cwd),
        );
        let surfacedError = false;
        try {
            for await (const event of turn) {
                if (event.kind === "error") {
                    surfacedError = true;
                }
                yield event;
            }
        } catch (error) {
            if (!surfacedError) {
                const message = error instanceof Error ? error.message : `${openCodeBackendLabel(provider)} agent failed`;
                // A thrown model-not-found (self-heal found no alternatives) gets the same code as the event path, so
                // the client reloads the catalog and drops the bad pinned model.
                yield { kind: "error", message, ...(MODEL_INVALID.test(message) ? { code: "grok-model-invalid" as const } : {}) };
            }
        } finally {
            // This turn's outside-content bit dies with the turn (guard/turn-taint.ts).
            release();
        }
        yield { kind: "done" };
    };
