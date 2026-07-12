import type { Event } from "@opencode-ai/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { AgentRequest } from "../agent/agent.js";
import { createPlanRequest } from "../agent/agent-requests.js";
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

// A turn with no OpenCode event for this long is treated as stuck and aborted — OpenCode can stall silently
// (e.g. while building a multimodal request) and emit neither session.idle nor session.error, which would
// otherwise hang the turn (no `done`) and spin the UI forever.
const GROK_INACTIVITY_MS = 120_000;

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
        await c.session.promptAsync({
            path: { id: sessionId },
            query: { directory: turn.cwd },
            body: {
                agent: turn.agent,
                ...(turn.model !== undefined && turn.model !== "" ? { model: { providerID: XAI, modelID: turn.model } } : {}),
                parts: [{ type: "text", text: turn.prompt }],
            },
        });
        // Drive the shared SSE iterator manually so each read can race an inactivity timeout (a `for await` can't),
        // and close it on exit (it's a per-turn subscription). Both session.idle and session.error are terminal —
        // OpenCode may not send idle after an error.
        const iterator: AsyncIterator<Event> = sse.stream[Symbol.asyncIterator]();
        try {
            for (;;) {
                const next = iterator.next();
                let timer: ReturnType<typeof setTimeout>;
                const idle = new Promise<"timeout">((resolve) => {
                    timer = setTimeout(() => resolve("timeout"), inactivityMs);
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
                yield event;
                if (event.type === "session.idle" || event.type === "session.error") {
                    return;
                }
            }
        } finally {
            await iterator.return?.().catch(() => {});
        }
    };

// OpenCode's lowercase tool ids → the display names the UI already styles (Claude-style). Unknown tools pass
// through unchanged. `todowrite` is intentionally absent — its checklist renders from the todo.updated event.
const TOOL_NAMES: Record<string, string> = {
    bash: "Bash",
    edit: "Edit",
    write: "Write",
    read: "Read",
    grep: "Grep",
    glob: "Glob",
    list: "LS",
    webfetch: "WebFetch",
    task: "Task",
    patch: "Edit",
};

// The file / command / query a tool acts on, for the `tool` frame's target — mirrors agent.ts's toolTarget.
const toolTarget = (input: Record<string, unknown>): string | undefined => {
    for (const key of ["filePath", "file_path", "command", "pattern", "url", "path"]) {
        const value = input[key];
        if (typeof value === "string") {
            return value;
        }
    }
    return undefined;
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
}

// Normalize one Grok turn's OpenCode Event stream onto AgentEvents. `capture` set ⇒ plan phase: text is
// accumulated (not streamed) so the whole plan surfaces as one `plan` frame. Ends on session.idle; does NOT
// emit the terminal `done` (the caller does once the whole turn settles).
async function* streamTurn(events: AsyncIterable<Event>, capture?: TurnCapture): AsyncGenerator<AgentEvent> {
    // Per-part emitted text length, so each message.part.updated yields only the new suffix (works whether the
    // server sends incremental deltas or full snapshots).
    const emitted = new Map<string, number>();
    // callIDs that have already emitted their opening `tool` frame, so a completed/error state doesn't repeat it.
    const started = new Set<string>();
    // Token/cost accounting per assistant message: OpenCode carries it on the message info (not its parts) and an
    // agentic turn has several assistant messages, so key by id (latest snapshot wins) and sum once at idle.
    const usage = new Map<
        string,
        { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }
    >();

    for await (const event of events) {
        if (event.type === "session.created") {
            if (capture !== undefined) {
                capture.sessionId = event.properties.info.id;
            }
            yield { kind: "session", sessionId: event.properties.info.id };
        } else if (event.type === "message.part.updated") {
            const part = event.properties.part;
            if (part.type === "text") {
                const prev = emitted.get(part.id) ?? 0;
                if (part.text.length > prev) {
                    const slice = part.text.slice(prev);
                    emitted.set(part.id, part.text.length);
                    if (capture !== undefined) {
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
                const name = TOOL_NAMES[part.tool] ?? part.tool;
                const state = part.state;
                if ((state.status === "running" || state.status === "completed" || state.status === "error") && !started.has(part.callID)) {
                    started.add(part.callID);
                    const target = toolTarget(state.input);
                    yield { kind: "tool", id: part.callID, name, ...(target !== undefined ? { target } : {}) };
                }
                if (state.status === "completed") {
                    yield { kind: "tool_result", id: part.callID, output: state.output };
                } else if (state.status === "error") {
                    yield { kind: "tool_result", id: part.callID, output: state.error, isError: true };
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
            // Terminal: OpenCode does not reliably emit session.idle after an error, so ending here (rather than
            // waiting for an idle that never comes) is what lets runGrokAgent reach its `done`.
            return;
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
            return;
        }
    }
}

const PLAN_PREAMBLE =
    "Before making any changes, propose a clear, concise plan for the request below and stop — do not execute it yet. End your reply with the plan itself.\n\n";

// Always-plan flow, two phases (mirrors runCodexPlanTurn): a read-only planning turn on the `plan` agent whose
// assistant text becomes the `plan` frame, then — once approved on the shared decision bridge — an execution
// turn on the `build` agent resumed on the same session. Rejection feedback loops another planning turn.
// ponytail: no `question` frames — OpenCode's permission channel maps to per-tool approvals, not multiple-choice
// clarifying questions; a dedicated ask-tool is the upgrade path.
async function* runGrokPlanTurn(request: AgentRequest, runner: GrokRunner): AsyncGenerator<AgentEvent> {
    let prompt = PLAN_PREAMBLE + request.prompt;
    let sessionId = request.sessionId;
    for (;;) {
        const capture: TurnCapture = sessionId !== undefined ? { sessionId } : {};
        yield* streamTurn(
            runner({
                prompt,
                ...(sessionId !== undefined ? { sessionId } : {}),
                cwd: request.cwd,
                ...(request.model !== undefined ? { model: request.model } : {}),
                agent: "plan",
                signal: request.signal,
            }),
            capture,
        );
        sessionId = capture.sessionId;
        if (capture.planText === undefined || capture.planText.trim() === "" || request.signal.aborted) {
            // The planning turn errored/aborted without producing a plan — the error frame already streamed.
            return;
        }
        const { id, wait } = createPlanRequest();
        yield { kind: "plan", decisionId: id, text: capture.planText };
        const decision = await wait(request.signal);
        if (request.signal.aborted) {
            return;
        }
        if (!decision.approve) {
            const feedback = decision.feedback?.trim();
            prompt =
                feedback !== undefined && feedback !== ""
                    ? `The user rejected the plan with this feedback:\n${feedback}\n\nRevise the plan. Still do not execute it.`
                    : "The user rejected the plan. Revise it. Still do not execute it.";
            continue;
        }
        yield* streamTurn(
            runner({
                prompt: "The plan is approved — execute it now.",
                ...(sessionId !== undefined ? { sessionId } : {}),
                cwd: request.cwd,
                ...(request.model !== undefined ? { model: request.model } : {}),
                agent: "build",
                signal: request.signal,
            }),
        );
        return;
    }
}

const withFileNote = (prompt: string, files: readonly string[]): string =>
    files.length === 0 ? prompt : `${prompt}\n\nThe user attached these files — read them as needed:\n${files.map((path) => `- ${path}`).join("\n")}`;

// Build the Grok provider for the Services seam: AgentRequest in, AgentEvent frames out. The agent route has
// already gated that xAI is connected. Ignores the Claude-only request fields (oauthToken, permissionMode,
// plugins, thinking, tools).
export const createGrokAgent = (runner: GrokRunner) =>
    async function* runGrokAgent(request: AgentRequest): AsyncGenerator<AgentEvent> {
        const prompt = withFileNote(request.prompt, request.attachments ?? []);
        const turn =
            request.plan === true
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
                yield { kind: "error", message: error instanceof Error ? error.message : "grok agent failed" };
            }
        }
        yield { kind: "done" };
    };
