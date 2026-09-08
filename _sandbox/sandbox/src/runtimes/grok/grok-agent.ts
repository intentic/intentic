import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { IMAGE_MIME } from "../../image-mime.js";
import { errorMessage } from "@intentic/base/errors";
import type { Event, FilePartInput, ToolPart } from "@opencode-ai/sdk";
import type { AgentEvent, ToolCallLocation } from "@intentic/sandbox-contract";
import { whenAborted } from "../../abort.js";
import type { AgentRequest } from "../../agent/run/agent.js";
import { splitAttachments, withFileNote } from "../../agent/prompt/attachment-note.js";
import { unsentParameterFrame } from "../../agent/run/error-frames.js";
import { isUnsentParameterRefusalText, mentionsSpentAllowance } from "../../agent/providers/failure-sentences.js";
import { EXECUTE_PROMPT, type ExecutePhase, PLAN_PREAMBLE, type PlanPhase, runPlanEmulation } from "../../agent/prompt/plan-emulation.js";
import { displayNameOf, editDiffContent, toolCategoryOf, toolLocations, toolTarget } from "../../agent/tools/tool-calls.js";
import type { CommandGate } from "../../guard/command-gate.js";
import { createTurnGate } from "../../guard/turn-gate.js";
import { isChatModel, parseModelSuggestions } from "./grok-models.js";
import { openCodeBackendLabel, type OpenCodeService, registerSessionGate, releaseSessionGate } from "./opencode.js";

// xAI Grok provider adapter (same seam as agent.ts's runAgent): AgentRequest in, AgentEvent frames out, backed by
// OpenCode, which owns sessions, tools, file edits and the OAuth credential (providerID "xai"). Auth is subscription
// OAuth, persisted by OpenCode; no per-turn key. Permissions run allow-all: the container is the isolation boundary.

// The xAI provider id in OpenCode / models.dev, and the default backend for a turn that names none.
const XAI = "xai";

// One Grok turn; the runner creates/resumes the session and yields its OpenCode events. Injected so tests drive a fake
// Event stream with no server.
export interface GrokTurn {
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
    readonly gate?: CommandGate;
    // Standing instructions appended via OpenCode's `system` field (added to, not replacing, OpenCode's own prompt);
    // per message, not per session.
    readonly system?: string;
    // Images already read off disk, sent as native parts rather than named as paths in the prompt; read in the adapter
    // so an unreadable one falls back to a prompt note.
    readonly images?: readonly FilePartInput[];
    readonly signal: AbortSignal;
}
export type GrokRunner = (turn: GrokTurn) => AsyncIterable<Event>;

// Builds native image parts as base64 data URLs (the server is reached over HTTP, not a shared filesystem); unreadable
// files come back as `unread`.
const imageParts = async (paths: readonly string[]): Promise<{ parts: FilePartInput[]; unread: string[] }> => {
    const parts: FilePartInput[] = [];
    const unread: string[] = [];
    for (const path of paths) {
        try {
            const data = await readFile(path);
            const mime = IMAGE_MIME[extname(path).toLowerCase()] ?? "image/png";
            parts.push({ type: "file", mime, filename: basename(path), url: `data:${mime};base64,${data.toString("base64")}` });
        } catch {
            unread.push(path);
        }
    }
    return { parts, unread };
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

// No OpenCode event for this session within this window means the turn is stuck and gets aborted.
const GROK_INACTIVITY_MS = 120_000;

// Hard overall backstop: even if the session keeps dribbling events, one turn must not run forever.
const GROK_MAX_TURN_MS = 30 * 60_000;

// How long the stream gets to say hello before the turn proceeds without proof it's listening; short compared to the
// inactivity watchdog.
const CONNECT_MS = 5_000;

// A closed stream without session.idle/session.error means the shared opencode serve went away, not a finished turn;
// throws, except when this turn's own abort is what closed it (returns quietly).
const refuseEarlyClose = (turn: GrokTurn): void => {
    if (turn.signal.aborted) {
        return;
    }
    throw new Error(`${openCodeBackendLabel(turn.provider ?? XAI)} stopped sending events before the turn ended.`);
};

// Production runner: creates/resumes the session on the shared OpenCode client, fires the prompt, and yields the
// session's events off the global SSE stream. `inactivityMs` is injectable for tests.
export const createGrokRunner = (openCode: OpenCodeService, inactivityMs: number = GROK_INACTIVITY_MS): GrokRunner =>
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
        // Drives the iterator manually so each read can race an inactivity timeout (`for await` can't); closed on exit
        // since it's per-turn. Two wall-clock deadlines: inactivity advances only on this session's events, turn
        // deadline is a hard backstop.
        const turnDeadline = Date.now() + GROK_MAX_TURN_MS;
        let inactivityDeadline = Date.now() + inactivityMs;
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
                    let timer: ReturnType<typeof setTimeout>;
                    const idle = new Promise<"timeout">((resolve) => {
                        timer = setTimeout(() => resolve("timeout"), Math.max(0, Math.min(inactivityDeadline, turnDeadline) - Date.now()));
                    });
                    const result = await Promise.race([next, idle]);
                    clearTimeout(timer!);
                    if (result === "timeout") {
                        next.catch(() => {}); // swallow the abandoned read
                        await c.session.abort({ path: { id: sessionId } }).catch(() => {});
                        throw new Error(`${openCodeBackendLabel(turn.provider ?? XAI)} turn timed out waiting for OpenCode.`);
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
                inactivityDeadline = Date.now() + inactivityMs;
                // OpenCode announces an in-turn retry wait once, with the instant of the next attempt; the inactivity
                // deadline moves past that instant so a long backoff isn't read as a hang, still bounded by the hard
                // turn cap.
                if (event.type === "session.status" && event.properties.status.type === "retry") {
                    inactivityDeadline = Math.max(inactivityDeadline, event.properties.status.next + inactivityMs);
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

// A refusal driven by quota/allowance, not a real error; coded so the chat offers a retry-later notice instead of a
// Continue that would just re-fail.
const RATE_LIMITED = /rate.?limit|resource.?exhausted|too many requests|\b429\b/i;

const isRateLimited = (message: string): boolean => mentionsSpentAllowance(message) || RATE_LIMITED.test(message);

// Plan phase holds back the assistant text (it becomes the plan) instead of streaming it; `sessionId` is captured from
// session.created (or the resumed id) for the execute phase to resume.
interface TurnCapture {
    sessionId?: string;
    planText?: string;
    // Set on a session.error during the plan phase, so a failed turn never surfaces a bogus plan frame.
    errored?: boolean;
}

// Target/locations a tool call's input implies, read once since the opening frame and an already-finished call need the
// same pair.
const toolCallDetails = (input: unknown, cwd: string): { target?: string; locations?: ToolCallLocation[] } => {
    const target = toolTarget(input);
    const locations = toolLocations(input, cwd);
    return { ...(target !== undefined ? { target } : {}), ...(locations !== undefined ? { locations } : {}) };
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
        ? {
              kind: "tool_call",
              id: part.callID,
              name,
              category: toolCategoryOf(name),
              status,
              ...toolCallDetails(state.input, cwd),
              content,
          }
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
            yield {
                kind: "tool_call",
                id: part.callID,
                name,
                category: toolCategoryOf(name),
                status: "in_progress",
                ...toolCallDetails(state.input, cwd),
            };
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
    const usage = new Map<
        string,
        { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }
    >();
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
                usage.set(info.id, {
                    inputTokens: info.tokens.input,
                    outputTokens: info.tokens.output,
                    cacheReadTokens: info.tokens.cache.read,
                    cacheCreationTokens: info.tokens.cache.write,
                    costUsd: info.cost,
                });
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
            const message = errorText(event.properties.error);
            // Checked first: the refusal ends in "on this model", which would otherwise trip the model-invalid branch
            // and drop a pinned model that was never at fault. Every routed provider shares the proxy that can produce
            // it.
            yield isUnsentParameterRefusalText(message)
                ? unsentParameterFrame(message)
                : {
                      kind: "error",
                      message,
                      ...(MODEL_INVALID.test(message)
                          ? { code: "grok-model-invalid" as const }
                          : isRateLimited(message)
                            ? { code: "rate_limit" as const }
                            : {}),
                  };
            capture.errored = true;
            // Terminal: OpenCode doesn't reliably emit session.idle after an error, so ending here is what lets the
            // caller reach `done`.
            return capture;
        } else if (event.type === "session.idle") {
            if (usage.size > 0) {
                const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
                for (const t of usage.values()) {
                    total.inputTokens += t.inputTokens;
                    total.outputTokens += t.outputTokens;
                    total.cacheReadTokens += t.cacheReadTokens;
                    total.cacheCreationTokens += t.cacheCreationTokens;
                    total.costUsd += t.costUsd;
                }
                yield { kind: "usage", ...total };
            }
            return capture;
        }
    }
    return capture;
}

// Plan flow over the shared skeleton: a read-only turn on the `plan` agent whose text becomes the plan, then execution
// on `build` resumed on the same session. No `question` frames: OpenCode's permission channel maps to per-tool
// approvals only, declared as `questions: false` in this runtime's capability row.
async function* runGrokPlanTurn(
    request: AgentRequest,
    runner: GrokRunner,
    provider: string,
    gate: CommandGate,
    firstTurnImages: readonly FilePartInput[],
): AsyncGenerator<AgentEvent> {
    // Both phases carry the same standing instructions; they're two messages of one turn, so the execute phase must not
    // drop them.
    const system = request.systemAppend;
    // Images ride the first planning message only; every later message resumes the same session, whose history already
    // holds them.
    let images = firstTurnImages;
    const planPhase: PlanPhase = async function* (prompt, sessionId) {
        const capture = yield* streamTurn(
            runner({
                prompt,
                ...(images.length > 0 ? { images } : {}),
                ...(sessionId !== undefined ? { sessionId } : {}),
                cwd: request.cwd,
                ...(request.model !== undefined ? { model: request.model } : {}),
                provider,
                agent: "plan",
                gate,
                ...(system !== undefined ? { system } : {}),
                signal: request.signal,
            }),
            request.cwd,
            true,
            sessionId,
        );
        images = [];
        return { sessionId: capture.sessionId, planText: capture.planText, errored: capture.errored === true };
    };
    const executePhase: ExecutePhase = (sessionId) =>
        streamTurn(
            runner({
                prompt: EXECUTE_PROMPT,
                ...(sessionId !== undefined ? { sessionId } : {}),
                cwd: request.cwd,
                ...(request.model !== undefined ? { model: request.model } : {}),
                provider,
                agent: "build",
                gate,
                ...(system !== undefined ? { system } : {}),
                signal: request.signal,
            }),
            request.cwd,
        );
    yield* runPlanEmulation(request.signal, PLAN_PREAMBLE + request.prompt, request.sessionId, planPhase, executePhase);
}

// Builds the Grok provider for the Services seam. The agent route has already gated that xAI is connected; capability
// limits (no permission mode but `plan`, no effort) are declared in the contract's agent-catalog.ts, not enforced here.
export const createGrokAgent = (runner: GrokRunner, provider: string = XAI) =>
    async function* runGrokAgent(request: AgentRequest): AsyncGenerator<AgentEvent> {
        // Pictures go to the model as pictures; everything else, including an unreadable picture, is named in the
        // prompt for the read tool.
        const { images: attachedImages, others } = splitAttachments(request.attachments);
        const { parts: images, unread } = await imageParts(attachedImages);
        const prompt = withFileNote(request.prompt, [...others, ...unread]);
        // Turn's safety wiring (guard/turn-gate.ts): rulebook answered over OpenCode's permission channel. `canPark:
        // false`: the watchdog aborts a turn with no session event in two minutes, so a paused permission would be read
        // as a hang; a hold is delivered as a refusal instead, and the capability record says `rulebook:
        // "refuse-only"`.
        const { gate, release } = createTurnGate(request);
        const turn =
            request.permissionMode === "plan"
                ? runGrokPlanTurn({ ...request, prompt }, runner, provider, gate, images)
                : streamTurn(
                      runner({
                          prompt,
                          ...(images.length > 0 ? { images } : {}),
                          ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
                          cwd: request.cwd,
                          ...(request.model !== undefined ? { model: request.model } : {}),
                          provider,
                          agent: "build",
                          gate,
                          ...(request.systemAppend !== undefined ? { system: request.systemAppend } : {}),
                          signal: request.signal,
                      }),
                      request.cwd,
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
