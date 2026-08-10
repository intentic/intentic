import type { Event } from "@opencode-ai/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { AgentRequest } from "../agent/agent.js";
import { withFileNote } from "../agent/attachment-note.js";
import { EXECUTE_PROMPT, type ExecutePhase, PLAN_PREAMBLE, type PlanPhase, runPlanEmulation } from "../agent/plan-emulation.js";
import { displayNameOf, editDiffContent, toolCategoryOf, toolLocations, toolTarget } from "../agent/tool-calls.js";
import { isChatModel, parseModelSuggestions } from "./grok-models.js";
import type { OpenCodeService } from "./opencode.js";

/* The xAI Grok provider adapter: same seam as agent.ts's runAgent — AgentRequest in, AgentEvent frames out —
 * backed by OpenCode (`@opencode-ai/sdk`) pointed at xAI Grok. OpenCode is itself the agentic runtime
 * (sessions, tools, file edits) and holds the OAuth credential; Grok is the model backend (providerID "xai").
 * Provider differences stay inside this file; the wire contract, routes, and UI are shared.
 *
 * Auth is subscription OAuth (SuperGrok / X Premium), driven by the Grok routes and persisted by OpenCode — no
 * per-turn key. The turn just resolves a session and streams. Permissions run allow-all because the container
 * is the isolation boundary (same posture as the Claude/Codex paths). */

// The xAI provider id in OpenCode / models.dev.
const XAI = "xai";

// One Grok turn. Injected so tests drive a fake Event stream — no server, no network (the QueryFn/CodexRunner
// pattern). The runner creates/resumes the session and yields the OpenCode events for it.
export interface GrokTurn {
    readonly prompt: string;
    readonly sessionId?: string;
    readonly cwd: string;
    readonly model?: string;
    // The built-in OpenCode agent: "plan" is read-only (proposes), "build" executes.
    readonly agent: "plan" | "build";
    readonly signal: AbortSignal;
}
export type GrokRunner = (turn: GrokTurn) => AsyncIterable<Event>;

// The session an event belongs to, for filtering the global stream down to this turn's session.
const eventSessionId = (event: Event): string | undefined => {
    switch (event.type) {
        case "session.created":
            return event.properties.info.id;
        case "session.idle":
        case "session.error":
        case "todo.updated":
        case "permission.updated":
            return event.properties.sessionID;
        case "message.part.updated":
            return event.properties.part.sessionID;
        case "message.updated":
            return event.properties.info.sessionID;
        default:
            return undefined;
    }
};

// A turn with no OpenCode event for OUR session for this long is treated as stuck and aborted — OpenCode can
// stall silently (e.g. while building a multimodal request) and emit neither session.idle nor session.error,
// which would otherwise hang the turn (no `done`) and spin the UI forever.
const GROK_INACTIVITY_MS = 120_000;

// Hard overall backstop: even if our session keeps dribbling events, one turn must not run forever.
const GROK_MAX_TURN_MS = 30 * 60_000;

// The production runner: use the shared OpenCode client to create/resume the session, fire the prompt on the
// xAI provider, and yield the session's events off the global SSE stream. `inactivityMs` is injectable for tests.
export const createGrokRunner = (openCode: OpenCodeService, inactivityMs: number = GROK_INACTIVITY_MS): GrokRunner =>
    async function* (turn) {
        const c = await openCode.client();
        // Subscribe BEFORE creating/prompting so the session.created + early part events aren't missed.
        const sse = await c.event.subscribe();
        let sessionId = turn.sessionId;
        if (sessionId === undefined) {
            const created = await c.session.create({ query: { directory: turn.cwd } });
            sessionId = created.data?.id;
            if (sessionId === undefined) {
                throw new Error("OpenCode did not return a session id");
            }
        }
        turn.signal.addEventListener("abort", () => void c.session.abort({ path: { id: sessionId } }).catch(() => {}), { once: true });
        // Fire the turn's prompt on the resolved session for a given model id (empty ⇒ let OpenCode choose). Reused
        // by the self-heal below to re-prompt with a corrected model after a "model not found" rejection.
        const sendPrompt = (modelId: string | undefined): ReturnType<typeof c.session.promptAsync> =>
            c.session.promptAsync({
                path: { id: sessionId },
                query: { directory: turn.cwd },
                body: {
                    agent: turn.agent,
                    ...(modelId !== undefined && modelId !== "" ? { model: { providerID: XAI, modelID: modelId } } : {}),
                    parts: [{ type: "text", text: turn.prompt }],
                },
            });
        // One self-heal attempt per turn: xAI names the account's valid models when it rejects a stale/renamed id.
        let retried = false;
        // After a self-heal re-prompt, a lingering session.idle from the FAILED prompt could end the turn before
        // the corrected one streams. While true, ignore idle until the retry's first real event proves it started.
        let awaitingRetryStart = false;
        // Fire the initial prompt. xAI rejects a stale/renamed (or seed) model id by REJECTING promptAsync (a thrown
        // ProviderModelNotFoundError) rather than via a session.error event, so the in-loop self-heal below never
        // sees it — heal it here the same way (record xAI's named models, re-prompt once with a valid one) so a
        // stale pinned/default model self-corrects silently instead of surfacing raw. A rejected prompt streamed no
        // events, so there's no stale idle to skip (no awaitingRetryStart needed).
        try {
            await sendPrompt(turn.model);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const suggestions = MODEL_INVALID.test(message) ? parseModelSuggestions(message).filter(isChatModel) : [];
            if (suggestions[0] === undefined) {
                throw error;
            }
            retried = true;
            await openCode.recordModels(suggestions);
            await sendPrompt(suggestions[0]);
        }
        // Drive the shared SSE iterator manually so each read can race an inactivity timeout (a `for await` can't),
        // and close it on exit (it's a per-turn subscription). Both session.idle and session.error are terminal —
        // OpenCode may not send idle after an error.
        const iterator: AsyncIterator<Event> = sse.stream[Symbol.asyncIterator]();
        // Two independent bounds, measured against wall-clock deadlines rather than a fresh per-read timer: the
        // inactivity deadline advances only on OUR session's events (a busy sibling session on the shared stream
        // must not keep a wedged target turn's watchdog from firing), and the turn deadline is a hard backstop.
        const turnDeadline = Date.now() + GROK_MAX_TURN_MS;
        let inactivityDeadline = Date.now() + inactivityMs;
        try {
            for (;;) {
                const next = iterator.next();
                let timer: ReturnType<typeof setTimeout>;
                const idle = new Promise<"timeout">((resolve) => {
                    timer = setTimeout(() => resolve("timeout"), Math.max(0, Math.min(inactivityDeadline, turnDeadline) - Date.now()));
                });
                const result = await Promise.race([next, idle]);
                clearTimeout(timer!);
                if (result === "timeout") {
                    next.catch(() => {}); // swallow the abandoned read
                    await c.session.abort({ path: { id: sessionId } }).catch(() => {});
                    throw new Error("Grok turn timed out waiting for OpenCode.");
                }
                if (result.done) {
                    return;
                }
                const event = result.value;
                if (eventSessionId(event) !== sessionId) {
                    continue;
                }
                inactivityDeadline = Date.now() + inactivityMs;
                // Self-heal a stale/renamed model in-place, instead of surfacing the error and making the user
                // re-send: xAI's rejection NAMES the account's valid models (the authoritative catalog). Record
                // them (fixes the picker + every future turn) and re-prompt this same session once with a valid
                // one. Model-not-found is rejected before any content streams, so nothing is duplicated. A second
                // failure (retried already true) falls through and surfaces as a real error.
                if (event.type === "session.error" && !retried) {
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
                    // Drop a stale idle from the failed prompt; any other event (content, or the retry's own error)
                    // means the corrected turn is under way, so resume normal processing.
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
        }
    };

// Flatten an OpenCode session error onto a message (every NamedError carries data.message).
const errorText = (error: unknown): string => {
    const named = error as { data?: { message?: string }; name?: string } | undefined;
    return named?.data?.message ?? named?.name ?? "agent error";
};

// xAI surfaces an unknown/retired model id as a "model not found" session error (listing valid alternatives).
// Tag it so the client reloads the live catalog and drops the bad pinned model, mirroring the session-not-found
// self-heal — any other error stays uncoded (e.g. an auth rejection).
const MODEL_INVALID = /model not found|does not exist|no such model|did you mean/i;

// Plan phase holds back the assistant text (it becomes the plan) instead of streaming it; `sessionId` is the
// session to resume for the execute phase, captured from session.created (or the resumed id).
interface TurnCapture {
    sessionId?: string;
    planText?: string;
    // Set when the plan phase hit a session.error, so runGrokPlanTurn suppresses the plan frame — a failed turn
    // must not surface a "plan" (the error already streamed), even if partial/echoed text reached planText.
    errored?: boolean;
}

// Normalize one Grok turn's OpenCode Event stream onto AgentEvents, RETURNING what the turn captured — the plan
// phase reads it off the `yield*` (as runPlanEmulation reads PlanPhaseResult off the phase), an ordinary turn
// discards it. `holdText` is the plan phase's one behavioural difference: text is accumulated rather than
// streamed, so the whole plan surfaces as one `plan` frame. `resumedSessionId` seeds the capture, because a
// resumed session emits no session.created and the execute phase still needs a session to continue.
// Ends on session.idle; does NOT emit the terminal `done` (the caller does once the whole turn settles).
async function* streamTurn(
    events: AsyncIterable<Event>,
    cwd: string,
    holdText = false,
    resumedSessionId?: string,
): AsyncGenerator<AgentEvent, TurnCapture> {
    const capture: TurnCapture = resumedSessionId !== undefined ? { sessionId: resumedSessionId } : {};
    // Per-part emitted text length, so each message.part.updated yields only the new suffix (works whether the
    // server sends incremental deltas or full snapshots).
    const emitted = new Map<string, number>();
    // callIDs that have already emitted their opening tool_call frame, so later states ride tool_call_update
    // instead of repeating it.
    const started = new Set<string>();
    // Token/cost accounting per assistant message: OpenCode carries it on the message info (not its parts) and an
    // agentic turn has several assistant messages, so key by id (latest snapshot wins) and sum once at idle.
    const usage = new Map<
        string,
        { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }
    >();
    // Message id → role, so a text part is attributed to its owner. OpenCode broadcasts the USER message's parts on
    // this same session stream, and a text Part carries no role — without this, the prompt echoes into planText/delta.
    const roleOf = new Map<string, "user" | "assistant">();

    for await (const event of events) {
        if (event.type === "session.created") {
            capture.sessionId = event.properties.info.id;
            yield { kind: "session", sessionId: event.properties.info.id };
        } else if (event.type === "message.part.updated") {
            const part = event.properties.part;
            // Only the ASSISTANT's text is the answer/plan. A part whose message is the user's (the echoed prompt)
            // is skipped; unknown (role not yet seen) is treated as assistant so early assistant text isn't dropped.
            if (part.type === "text" && roleOf.get(part.messageID) !== "user") {
                const prev = emitted.get(part.id) ?? 0;
                if (part.text.length > prev) {
                    const slice = part.text.slice(prev);
                    emitted.set(part.id, part.text.length);
                    if (holdText) {
                        capture.planText = (capture.planText ?? "") + slice;
                    } else {
                        yield { kind: "delta", text: slice };
                    }
                }
            } else if (part.type === "reasoning") {
                const prev = emitted.get(part.id) ?? 0;
                if (part.text.length > prev) {
                    yield { kind: "thinking", text: part.text.slice(prev) };
                    emitted.set(part.id, part.text.length);
                }
            } else if (part.type === "tool" && part.tool !== "todowrite") {
                const name = displayNameOf(part.tool);
                const state = part.state;
                // `pending` is skipped: OpenCode is still streaming the input args, so a target/locations read
                // now could be partial. The first useful state is `running` (input settled).
                if (state.status === "pending") {
                    continue;
                }
                const first = !started.has(part.callID);
                if (first) {
                    started.add(part.callID);
                }
                if (state.status === "running") {
                    if (first) {
                        const target = toolTarget(state.input);
                        const locations = toolLocations(state.input, cwd);
                        yield {
                            kind: "tool_call",
                            id: part.callID,
                            name,
                            category: toolCategoryOf(name),
                            status: "in_progress",
                            ...(target !== undefined ? { target } : {}),
                            ...(locations !== undefined ? { locations } : {}),
                        };
                    }
                    continue;
                }
                // completed | error. An edit/write completion derives its diff from the (now-final) input — the
                // authoritative content; otherwise the tool's text output/error is. A call first seen here (the
                // stream skipped running) arrives as one whole tool_call carrying its final status.
                const failed = state.status === "error";
                const diff = failed ? undefined : editDiffContent(name, state.input, cwd);
                const content = [diff ?? { type: "text" as const, text: failed ? state.error : state.output }];
                if (first) {
                    const target = toolTarget(state.input);
                    const locations = toolLocations(state.input, cwd);
                    yield {
                        kind: "tool_call",
                        id: part.callID,
                        name,
                        category: toolCategoryOf(name),
                        status: failed ? "failed" : "completed",
                        ...(target !== undefined ? { target } : {}),
                        ...(locations !== undefined ? { locations } : {}),
                        content,
                    };
                } else {
                    yield { kind: "tool_call_update", id: part.callID, status: failed ? "failed" : "completed", content };
                }
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
            // Attribute this message's role so its text parts are captured (assistant) or skipped (user) above.
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
        } else if (event.type === "session.error") {
            const message = errorText(event.properties.error);
            yield { kind: "error", message, ...(MODEL_INVALID.test(message) ? { code: "grok-model-invalid" as const } : {}) };
            capture.errored = true;
            // Terminal: OpenCode does not reliably emit session.idle after an error, so ending here (rather than
            // waiting for an idle that never comes) is what lets runGrokAgent reach its `done`.
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

// Always-plan flow over the shared skeleton: a read-only planning turn on the `plan` agent whose assistant
// text becomes the plan, then an execution turn on the `build` agent resumed on the same session.
// No `question` frames — OpenCode's permission channel maps to per-tool approvals, not multiple-choice
// clarifying questions; a dedicated ask-tool is the upgrade path. Declared as `questions: false` in this
// runtime's capability row, which is what the composer says out loud.
async function* runGrokPlanTurn(request: AgentRequest, runner: GrokRunner): AsyncGenerator<AgentEvent> {
    const planPhase: PlanPhase = async function* (prompt, sessionId) {
        const capture = yield* streamTurn(
            runner({
                prompt,
                ...(sessionId !== undefined ? { sessionId } : {}),
                cwd: request.cwd,
                ...(request.model !== undefined ? { model: request.model } : {}),
                agent: "plan",
                signal: request.signal,
            }),
            request.cwd,
            true,
            sessionId,
        );
        return { sessionId: capture.sessionId, planText: capture.planText, errored: capture.errored === true };
    };
    const executePhase: ExecutePhase = (sessionId) =>
        streamTurn(
            runner({
                prompt: EXECUTE_PROMPT,
                ...(sessionId !== undefined ? { sessionId } : {}),
                cwd: request.cwd,
                ...(request.model !== undefined ? { model: request.model } : {}),
                agent: "build",
                signal: request.signal,
            }),
            request.cwd,
        );
    yield* runPlanEmulation(request.signal, PLAN_PREAMBLE + request.prompt, request.sessionId, planPhase, executePhase);
}

// Build the Grok provider for the Services seam: AgentRequest in, AgentEvent frames out. The agent route has
// already gated that xAI is connected and that OpenCode still holds the session. What this runtime does NOT do
// is declared as `capabilitiesOf(…).runtime === "opencode"` in the contract's agent-catalog.ts rather than
// silently dropped here: OpenCode owns its own tools, permissions and reasoning settings, so a request reaching
// this file carries no permission mode but `plan`, and no effort at all.
export const createGrokAgent = (runner: GrokRunner) =>
    async function* runGrokAgent(request: AgentRequest): AsyncGenerator<AgentEvent> {
        const prompt = withFileNote(request.prompt, request.attachments ?? []);
        const turn =
            request.permissionMode === "plan"
                ? runGrokPlanTurn({ ...request, prompt }, runner)
                : streamTurn(
                      runner({
                          prompt,
                          ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
                          cwd: request.cwd,
                          ...(request.model !== undefined ? { model: request.model } : {}),
                          agent: "build",
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
                const message = error instanceof Error ? error.message : "grok agent failed";
                // A thrown model-not-found (promptAsync rejected and the runner couldn't self-heal it — no named
                // alternatives) gets the same code as the event path, so the client reloads the catalog and drops
                // the bad pinned model rather than showing the raw error.
                yield { kind: "error", message, ...(MODEL_INVALID.test(message) ? { code: "grok-model-invalid" as const } : {}) };
            }
        }
        yield { kind: "done" };
    };
