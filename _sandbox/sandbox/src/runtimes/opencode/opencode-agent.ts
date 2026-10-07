import { basename } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { Event, FilePartInput, OpencodeClient, SessionPromptAsyncData, ToolPart } from "@opencode-ai/sdk";
import { type AgentEvent, OPENCODE } from "@intentic/sandbox-contract";
import { whenAborted } from "@intentic/base/async";
import type { AgentRequest, ContainerCredential } from "../../agent/providers/agent-request.js";
import { withFileNote } from "../../agent/prompt/attachment-note.js";
import { loadAttachments } from "../../agent/prompt/attachment-images.js";
import { type EmulatedPlan, EXECUTE_PROMPT, PLAN_PREAMBLE, planMode } from "../decorators/plan-mode.js";
import { beforeDeadline, DEFAULT_TURN_TIMEOUTS, EXPIRED, type TurnTimeouts, type TurnWatchdog, turnWatchdog } from "../decorators/turn-watchdog.js";
import { isRateLimited, vendorFailureFrame, type VendorRule } from "../decorators/vendor-errors.js";
import { isContextOverflowText } from "../../agent/providers/failure-sentences.js";
import { contextOverflowFrame, modelUnavailableFrame } from "../../agent/run/error-frames.js";
import { displayNameOf, toolTarget } from "@intentic/agent-context/tool-calls";
import { editDiffContent, toolLocations } from "../../agent/tools/tool-calls.js";
import type { CommandGuard } from "../../guard/command-guard.js";
import { planPhaseOf, toolCallOpened, type TurnCapture, usageTotals } from "../decorators/vendor-events.js";
import { vendorTurnGate } from "../decorators/vendor-gate.js";
import { opt } from "../../opt.js";
import { isChatModel, OPENCODE_XAI_PROVIDER, parseModelSuggestions } from "./xai-models.js";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { openCodeBackendLabel, type OpenCodeService, type SessionJudge, type SessionJudges } from "./opencode.js";
import { mcpServersOf, mcpToolNameOf, openCodeMounts, type OpenCodeMounts, visibleToolsOf } from "./opencode-mcp.js";
import { type OpenCodeSubagents, openCodeSubagents } from "./opencode-subagents.js";

// The OpenCode loop Grok and Gemini both run on: AgentRequest in, AgentEvent frames out, over one shared `opencode serve`.

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
    // The turn's MCP servers, mounted for the turn under its conversation's own names (opencode-mcp.ts); absent mounts
    // none, and the turn still sees no other conversation's.
    readonly mounts?: OpenCodeMounts;
    // Standing instructions appended via OpenCode's `system` field (added to, not replacing, OpenCode's own prompt);
    // per message, not per session.
    readonly system?: string;
    // Images already read off disk, sent as native parts rather than named as paths in the prompt; read in the adapter
    // so an unreadable one falls back to a prompt note.
    readonly images?: readonly FilePartInput[];
    readonly signal: AbortSignal;
}

// A frame the daemon raised for the turn itself (a permission card, then its resolution), carried in order with the
// session's events; OpenCode sends no event of this type.
export interface RaisedFrame {
    readonly type: "intentic.frame";
    readonly frame: AgentEvent;
}
export type OpenCodeTurnEvent = Event | RaisedFrame;
export type OpenCodeRunner = (turn: OpenCodeTurn) => AsyncIterable<OpenCodeTurnEvent>;

// What a race against the stream's next event answers when a raised frame is waiting instead.
const RAISED: unique symbol = Symbol("raised");

// The frames a turn's judge raises from the detached permission watcher, queued for the runner, which wakes on the next.
interface RaisedFrames {
    readonly push: (frame: AgentEvent) => void;
    readonly take: () => AgentEvent | undefined;
    readonly arrived: () => Promise<typeof RAISED>;
}

const raisedFrames = (): RaisedFrames => {
    const queue: AgentEvent[] = [];
    let wake = (): void => {};
    return {
        push: (frame: AgentEvent): void => {
            queue.push(frame);
            wake();
        },
        take: (): AgentEvent | undefined => queue.shift(),
        // Settles once a frame is pushed; asked for only with the queue empty, so none is missed.
        arrived: (): Promise<typeof RAISED> =>
            new Promise((resolve) => {
                wake = () => resolve(RAISED);
            }),
    };
};

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
    throw new Error(`${openCodeBackendLabel(turn.provider ?? OPENCODE_XAI_PROVIDER)} stopped sending events before the turn ended.`);
};

// A turn's stream as the connect handshake left it: the iterator, the read in flight, and an event already read.
interface OpenedStream {
    readonly iterator: AsyncIterator<Event>;
    readonly pending: Promise<IteratorResult<Event>>;
    readonly buffered: Event | undefined;
}

// `subscribe()` is lazy: the HTTP request fires only on the first read, so it must happen before the session is created
// or `session.created` is missed. The first read is awaited here, bounded by CONNECT_MS, and what it read is kept for
// the loop rather than dropped; unread, the same promise is still what the loop first awaits.
const openStream = async (sse: { readonly stream: AsyncIterable<Event> }): Promise<OpenedStream> => {
    const iterator = sse.stream[Symbol.asyncIterator]();
    const first = iterator.next();
    const hello = await Promise.race([first, new Promise<"unopened">((resolve) => setTimeout(() => resolve("unopened"), CONNECT_MS).unref())]);
    return hello === "unopened" || hello.done === true
        ? { iterator, pending: first, buffered: undefined }
        : { iterator, pending: iterator.next(), buffered: hello.value };
};

// Reads one turn's stream: a frame the turn's judge raised first, then the event the handshake already read, then the
// stream's next event raced against the watchdog and against the next raised frame. A read a frame or the deadline cut
// short stays in flight for the next call; undefined is the stream ending.
const turnReader = (opened: OpenedStream, clock: TurnWatchdog, raised: RaisedFrames) => {
    let pending = opened.pending;
    let held = opened.buffered;
    return async (): Promise<Event | RaisedFrame | typeof EXPIRED | undefined> => {
        for (;;) {
            const frame = raised.take();
            if (frame !== undefined) {
                return { type: "intentic.frame", frame };
            }
            if (held !== undefined) {
                const event = held;
                held = undefined;
                return event;
            }
            const next = pending;
            const result = await beforeDeadline(Promise.race([next, raised.arrived()]), clock);
            if (result === EXPIRED) {
                next.catch(() => {}); // allow(silent-catch): the abandoned read lost to the deadline, whose error is the answer
                return EXPIRED;
            }
            if (result !== RAISED) {
                pending = result.done === true ? pending : opened.iterator.next();
                return result.done === true ? undefined : result.value;
            }
        }
    };
};

// The session a turn runs on: the one it resumes, else a new one, named on creation so OpenCode skips auto-titling (an
// extra model call per unnamed session); the title string itself is unused.
const sessionFor = async (c: OpencodeClient, turn: OpenCodeTurn): Promise<string> => {
    if (turn.sessionId !== undefined) {
        return turn.sessionId;
    }
    const created = await c.session.create({ query: { directory: turn.cwd }, body: { title: `intentic conversation` } });
    const id = created.data?.id;
    if (id === undefined) {
        throw new Error("OpenCode did not return a session id");
    }
    return id;
};

// One message of the turn on a model id (empty means let OpenCode choose). `tools` shows the session its own
// conversation's MCP servers and no one else's; OpenCode keeps it as the session's rules until the next prompt replaces
// them.
const promptBodyOf = (turn: OpenCodeTurn, mounts: OpenCodeMounts, modelId: string | undefined): NonNullable<SessionPromptAsyncData["body"]> => ({
    agent: turn.agent,
    ...opt("model", modelId === undefined || modelId === "" ? undefined : { providerID: turn.provider ?? OPENCODE_XAI_PROVIDER, modelID: modelId }),
    ...opt("system", turn.system),
    tools: visibleToolsOf(mounts),
    // Images precede the text part.
    parts: [...(turn.images ?? []), { type: "text", text: turn.prompt }],
});

// xAI's named alternatives in a model-not-found rejection, chat models only; none for any other failure.
const modelSuggestions = (message: string): string[] => (MODEL_INVALID.test(message) ? parseModelSuggestions(message).filter(isChatModel) : []);

// Sends the turn's first message. xAI rejects a stale/renamed model id by rejecting promptAsync (thrown), not via a
// session.error event, so the in-loop self-heal never sees it; healed here the same way, once. Answers whether that one
// attempt is spent. No events stream on rejection, so no stale idle to skip.
const sendFirst = async (
    send: (modelId: string | undefined) => ReturnType<OpencodeClient["session"]["promptAsync"]>,
    model: string | undefined,
    heal: ((suggestions: string[]) => Promise<void>) | undefined,
): Promise<boolean> => {
    try {
        await send(model);
        return false;
    } catch (error) {
        const suggestions = heal === undefined ? [] : modelSuggestions(errorMessage(error));
        if (heal === undefined || suggestions[0] === undefined) {
            throw error;
        }
        await heal(suggestions);
        return true;
    }
};

// The one mid-turn self-heal: xAI names the account's valid models when it rejects a stale/renamed id, so they are
// recorded and the same session re-prompted once; nothing streams before that rejection, so nothing is duplicated, and a
// second failure falls through as a real error. Until the corrected turn's first real event, a lingering idle from the
// failed prompt is swallowed. Answers whether an event was the heal's own, kept from the turn.
const modelSelfHeal = (spent: boolean, heal: (suggestions: string[]) => Promise<void>) => {
    let retried = spent;
    let awaitingRetryStart = false;
    return async (event: Event): Promise<boolean> => {
        const suggestions = event.type === "session.error" && !retried ? modelSuggestions(errorText(event.properties.error)) : [];
        if (suggestions[0] !== undefined) {
            retried = true;
            awaitingRetryStart = true;
            await heal(suggestions);
            return true;
        }
        if (!awaitingRetryStart) {
            return false;
        }
        // Any event but an idle means the corrected turn is under way.
        awaitingRetryStart = event.type === "session.idle";
        return awaitingRetryStart;
    };
};

// A turn's session and the subagent sessions its task tool opens beneath it, each naming its parent, followed the way
// OpenCode's own `run` follows them: a subagent's work reaches the turn instead of being dropped as another session's,
// keeps the turn's watchdog fed, and answers to the rules its parent does, since its asks carry its own session id.
export const sessionFamily = (root: string, judge: SessionJudge | undefined, judges: SessionJudges) => {
    const members = new Set<string>();
    const join = (session: string): void => {
        members.add(session);
        if (judge !== undefined) {
            judges.register(session, judge);
        }
    };
    join(root);
    return {
        // Whose an event is: the turn's own session's, one of its subagents', or no concern of this turn's.
        whose: (event: Event): "own" | "subagent" | undefined => {
            if (event.type === "session.created" && event.properties.info.parentID !== undefined && members.has(event.properties.info.parentID)) {
                join(event.properties.info.id);
            }
            const session = eventSessionId(event);
            if (session === undefined || !members.has(session)) {
                return undefined;
            }
            return session === root ? "own" : "subagent";
        },
        // The judges die with their phase; a later permission belongs to no session judging it and gets the standing yes
        // (opencode.ts answerPermission).
        release: (): void => {
            for (const member of members) {
                judges.release(member);
            }
        },
    };
};

const abortSession = async (c: OpencodeClient, sessionId: string): Promise<void> => {
    // allow(silent-catch): a refused abort leaves the session ending on its own events or the watchdog
    await c.session.abort({ path: { id: sessionId } }).catch(() => {});
};

// Consumes only this session family's events; the setup/cleanup owner keeps its stream and runtime leased throughout.
async function* consumeTurn({
    c,
    turn,
    sessionId,
    read,
    clock,
    family,
    absorbed,
}: {
    readonly c: OpencodeClient;
    readonly turn: OpenCodeTurn;
    readonly sessionId: string;
    readonly read: ReturnType<typeof turnReader>;
    readonly clock: TurnWatchdog;
    readonly family: ReturnType<typeof sessionFamily>;
    readonly absorbed: ReturnType<typeof modelSelfHeal>;
}): AsyncGenerator<OpenCodeTurnEvent> {
    for (;;) {
        const event = await read();
        if (event === EXPIRED) {
            await abortSession(c, sessionId);
            throw new Error(
                `${openCodeBackendLabel(turn.provider ?? OPENCODE_XAI_PROVIDER)} turn timed out waiting for OpenCode: ${clock.expiry()}.`,
            );
        }
        if (event === undefined) {
            refuseEarlyClose(turn);
            return;
        }
        // A card the judge raised goes out as it came; it is the daemon's own doing, not OpenCode's activity.
        if (event.type === "intentic.frame") {
            yield event;
            continue;
        }
        const whose = family.whose(event);
        if (whose === undefined) {
            continue;
        }
        clock.touch();
        // A subagent's event never ends, retries or re-prompts the turn; streamTurn puts it under its task.
        if (whose === "subagent") {
            yield event;
            continue;
        }
        // Move inactivity past a retry's next attempt, still bounded by the hard turn cap.
        if (event.type === "session.status" && event.properties.status.type === "retry") {
            clock.extendPast(event.properties.status.next);
        }
        if (await absorbed(event)) {
            continue;
        }
        yield event;
        if (event.type === "session.idle" || event.type === "session.error") {
            return;
        }
    }
}

// Runs on a leased client; even setup before the session has a judge belongs to this turn's server lifetime.
async function* runOpenCodeTurn(
    openCode: OpenCodeService,
    c: OpencodeClient,
    turn: OpenCodeTurn,
    timeouts: TurnTimeouts,
): AsyncGenerator<OpenCodeTurnEvent> {
    // Subscribe/read before creating/prompting so the session's earliest events aren't missed; scoped to this turn's
    // directory, since an unscoped stream carries no session events.
    const stopStream = new AbortController();
    let opened: OpenedStream | undefined;
    let family: ReturnType<typeof sessionFamily> | undefined;
    let unmount = async (): Promise<void> => {};
    try {
        const sse = await openCode.events(turn.cwd, stopStream.signal);
        await openCode.watch(turn.cwd);
        opened = await openStream(sse);
        const sessionId = await sessionFor(c, turn);
        // whenAborted also handles a signal aborted before the session id existed.
        whenAborted(turn.signal, () => void abortSession(c, sessionId));
        const clock = turnWatchdog(timeouts);
        const raised = raisedFrames();
        family = sessionFamily(
            sessionId,
            turn.gate === undefined ? undefined : { gate: turn.gate, push: raised.push, hold: clock.hold },
            openCode.judges,
        );
        const mounts = turn.mounts ?? openCodeMounts(undefined, []);
        const sendPrompt = (modelId: string | undefined): ReturnType<typeof c.session.promptAsync> =>
            c.session.promptAsync({ path: { id: sessionId }, query: { directory: turn.cwd }, body: promptBodyOf(turn, mounts, modelId) });
        const heal = async (suggestions: string[]): Promise<void> => {
            await openCode.recordModels(suggestions);
            await sendPrompt(suggestions[0]);
        };
        // The self-heal remains xAI-specific. Google must never silently substitute another model.
        const selfHeals = (turn.provider ?? OPENCODE_XAI_PROVIDER) === OPENCODE_XAI_PROVIDER;
        unmount = await openCode.mount(turn.cwd, mcpServersOf(mounts));
        const healed = await sendFirst(sendPrompt, turn.model, selfHeals ? heal : undefined);
        clock.touch();
        yield* consumeTurn({
            c,
            turn,
            sessionId,
            read: turnReader(opened, clock, raised),
            clock,
            family,
            absorbed: modelSelfHeal(!selfHeals || healed, heal),
        });
    } finally {
        // The SDK prefetches on a native async generator: return() alone queues behind its pending read forever.
        stopStream.abort();
        // allow(silent-catch): closing a stream that already failed has nothing left to report
        await opened?.iterator.return?.().catch(() => {});
        family?.release();
        await unmount();
    }
}

export const createOpenCodeRunner = (openCode: OpenCodeService, timeouts: TurnTimeouts = DEFAULT_TURN_TIMEOUTS): OpenCodeRunner =>
    async function* (turn) {
        const lease = await openCode.acquire({ providerID: turn.provider ?? OPENCODE_XAI_PROVIDER, ...opt("modelID", turn.model) });
        try {
            yield* runOpenCodeTurn(openCode, lease.client, turn, timeouts);
        } finally {
            lease.release();
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

// Google's own NOT_FOUND sentence. The translator lists models from its built-in catalog, not per account, so a model it
// lists can still be one Google does not offer these accounts; Google answers 404 with this sentence. Coded
// `model-unavailable`, which hides the model from the picker for a day (usage/model-refusals.ts) instead of a bare
// sentence that names no model and invites the same send again.
const GOOGLE_NOT_FOUND = /requested entity was not found/i;

const googleRefusalFrame = (provider: string, model: string | undefined, message: string): AgentEvent | undefined =>
    provider === OPENCODE_GEMINI_PROVIDER && model !== undefined && model !== "" && GOOGLE_NOT_FOUND.test(message)
        ? modelUnavailableFrame(
              model,
              `Google refused ${model} for this sandbox's Google accounts ("${message}"): the translator lists it, but Google does not offer it to them.`,
          )
        : undefined;

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
    parent: string | undefined,
): AgentEvent => {
    const failed = state.status === "error";
    const diff = failed ? undefined : editDiffContent(name, state.input, cwd);
    const content = [diff ?? { type: "text" as const, text: failed ? state.error : state.output }];
    const status = failed ? ("failed" as const) : ("completed" as const);
    return first
        ? toolCallOpened({
              id: part.callID,
              name,
              status,
              target: toolTarget(state.input),
              locations: toolLocations(state.input, cwd),
              content,
              parentToolUseId: parent,
          })
        : { kind: "tool_call_update", id: part.callID, status, content };
};

// What a turn's frames are read against: where it runs, and how its tool keys are spelled for a reader (a mounted MCP
// server's tool as `mcp__<server>__<tool>`, opencode-mcp.ts).
interface TurnView {
    readonly cwd: string;
    readonly toolName: (raw: string) => string;
}

// Frames for one tool part, kept out of streamTurn's event walk. `started` is the set of callIDs that already opened a
// card, telling a first announcement from a later update; `parent` is the task call whose subagent made this one.
const toolPartFrames = (part: ToolPart, view: TurnView, started: Set<string>, parent?: string): AgentEvent[] => {
    const { cwd } = view;
    const name = displayNameOf(view.toolName(part.tool));
    const state = part.state;
    // `pending` is skipped: OpenCode is still streaming input args, so target/locations would read as partial.
    if (state.status === "pending") {
        return [];
    }
    const first = !started.has(part.callID);
    if (first) {
        started.add(part.callID);
    }
    if (state.status === "running") {
        return first
            ? [
                  toolCallOpened({
                      id: part.callID,
                      name,
                      target: toolTarget(state.input),
                      locations: toolLocations(state.input, cwd),
                      parentToolUseId: parent,
                  }),
              ]
            : [];
    }
    return [finishedToolCall(part, name, state, cwd, first, parent)];
};

// The subagent session an event belongs to: any session but the turn's own, once that is known (the runner lets only
// the turn's family through).
const subagentSession = (event: Event, own: string | undefined): string | undefined => {
    const session = eventSessionId(event);
    return session !== undefined && own !== undefined && session !== own ? session : undefined;
};

// What goes out without the turn's own reading: a card the turn's judge raised, as it came, wherever the stream is, or a
// subagent's event, under its task. Undefined for the turn's own events.
const passedThrough = (event: OpenCodeTurnEvent, own: string | undefined, subagents: OpenCodeSubagents): AgentEvent[] | undefined => {
    if (event.type === "intentic.frame") {
        return [event.frame];
    }
    const subagent = subagentSession(event, own);
    return subagent === undefined ? undefined : subagents.child(event, subagent);
};

// OpenCode's checklist as the panel's; anything past in-progress and completed reads as still to do.
const todoStatus = (status: string): "pending" | "in_progress" | "completed" =>
    status === "in_progress" || status === "completed" ? status : "pending";
const todosFrame = (todos: Extract<Event, { type: "todo.updated" }>["properties"]["todos"]): AgentEvent => ({
    kind: "todos",
    items: todos.map((todo) => ({ content: todo.content, status: todoStatus(todo.status) })),
});

// An in-turn provider retry, so the chat shows a wait rather than an apparent hang; `status: 429` lets the UI say it is
// rate-limiting rather than a dead turn. No maxAttempts: OpenCode names none, so none is invented.
const retryFrame = (status: { readonly attempt: number; readonly next: number; readonly message: string }): AgentEvent => ({
    kind: "provider_retry",
    attempt: status.attempt,
    nextAttemptAt: status.next,
    ...(isRateLimited(status.message) ? { status: 429 } : {}),
});

// Normalizes one turn's OpenCode Event stream onto AgentEvents, returning what it captured (the plan phase reads this
// off `yield*`). `holdText` accumulates text into one `plan` frame instead of streaming deltas; ends on session.idle
// without emitting the terminal `done`.
async function* streamTurn(
    events: AsyncIterable<OpenCodeTurnEvent>,
    view: TurnView,
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
    // The subagents this turn's task calls start, and their sessions' events put under those calls.
    const subagents = openCodeSubagents((part, parent) => toolPartFrames(part, view, started, parent), usage);

    for await (const event of events) {
        const passed = passedThrough(event, capture.sessionId, subagents);
        if (passed !== undefined) {
            yield* passed;
            continue;
        }
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
                yield* toolPartFrames(part, view, started);
                yield* subagents.task(part);
            }
        } else if (event.type === "todo.updated") {
            yield todosFrame(event.properties.todos);
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
            yield retryFrame(event.properties.status);
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
    (request: AgentRequest, provider: string, gate: CommandGuard, mounts: OpenCodeMounts) =>
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
        mounts,
        ...(request.spec.systemAppend !== undefined ? { system: request.spec.systemAppend } : {}),
        signal: request.signal,
    });

// Plan flow over the shared skeleton: a read-only turn on the `plan` agent whose text becomes the plan, then execution on
// `build` resumed on the same session. Pictures ride the first planning message only; every later message resumes the
// session whose history already holds them. No `question` frames: the capability row says `questions: false`.
const openCodePlan = (
    view: TurnView,
    runner: OpenCodeRunner,
    turnOf: ReturnType<typeof openCodeTurnOf>,
    prompt: string,
    firstImages: readonly FilePartInput[],
): EmulatedPlan => {
    let images = firstImages;
    return {
        prompt: PLAN_PREAMBLE + prompt,
        async *plan(phasePrompt, sessionId) {
            const capture = yield* streamTurn(runner(turnOf({ prompt: phasePrompt, images, sessionId, agent: "plan" })), view, true, sessionId);
            images = [];
            return planPhaseOf(capture);
        },
        execute: (sessionId) => streamTurn(runner(turnOf({ prompt: EXECUTE_PROMPT, images: [], sessionId, agent: "build" })), view),
    };
};

// undici's bare "fetch failed" names neither what was unreachable nor why: said as the local OpenCode server the turn
// could not reach, with the cause undici tucked away, since the next turn boots that server afresh (opencode.ts ensure).
const unreachableServer = (error: unknown, provider: string): string | undefined => {
    if (!(error instanceof TypeError) || error.message !== "fetch failed") {
        return undefined;
    }
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return `The local OpenCode server that runs ${openCodeBackendLabel(provider)} turns could not be reached${cause}. Send again: it is restarted for the next turn.`;
};

// A provider's loop on OpenCode's `provider` backend; capability limits are declared in the contract's agent-catalog.ts.
export const createOpenCodeAgent = (runner: OpenCodeRunner, provider: string = OPENCODE_XAI_PROVIDER) =>
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
        // Turn's safety wiring (guard/turn-gate.ts): rulebook answered over OpenCode's permission channel, a hold parked
        // on a card while the runner holds its watchdog (the capability record says `rulebook: "approval"`). Releasing
        // the gate as the turn ends settles a card OpenCode moved on from (a refused sibling ask stops its session).
        const { gate, release } = vendorTurnGate(request);
        // The turn's remote MCP servers, the same list Codex takes, mounted per phase by the runner.
        const mounts = openCodeMounts(request.spec.conversationId, request.tools.remote ?? []);
        const view: TurnView = { cwd: request.spec.cwd, toolName: mcpToolNameOf(mounts) };
        const turnOf = openCodeTurnOf(request, provider, gate, mounts);
        const turn = planMode(
            OPENCODE,
            request,
            () => openCodePlan(view, runner, turnOf, prompt, images),
            () => streamTurn(runner(turnOf({ prompt, images, sessionId: request.spec.sessionId, agent: "build" })), view),
        );
        let surfacedError = false;
        try {
            for await (const event of turn) {
                if (event.kind === "error") {
                    surfacedError = true;
                    yield (event.code === undefined ? googleRefusalFrame(provider, request.spec.model, event.message) : undefined) ?? event;
                    continue;
                }
                yield event;
            }
        } catch (error) {
            if (!surfacedError) {
                const message =
                    unreachableServer(error, provider) ?? (error instanceof Error ? error.message : `${openCodeBackendLabel(provider)} agent failed`);
                // A thrown model-not-found (self-heal found no alternatives) gets the same code as the event path, so
                // the client reloads the catalog and drops the bad pinned model.
                yield googleRefusalFrame(provider, request.spec.model, message) ?? {
                    kind: "error",
                    message,
                    ...(MODEL_INVALID.test(message) ? { code: "grok-model-invalid" as const } : {}),
                };
            }
        } finally {
            // This turn's outside-content bit and any card still open die with the turn (guard/turn-taint.ts).
            release();
        }
        yield { kind: "done" };
    };
