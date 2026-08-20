import type { Event } from "@opencode-ai/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { AgentRequest } from "../agent/agent.js";
import { withFileNote } from "../agent/attachment-note.js";
import { mentionsSpentAllowance } from "../agent/failure-sentences.js";
import { EXECUTE_PROMPT, type ExecutePhase, PLAN_PREAMBLE, type PlanPhase, runPlanEmulation } from "../agent/plan-emulation.js";
import { displayNameOf, editDiffContent, toolCategoryOf, toolLocations, toolTarget } from "../agent/tool-calls.js";
import { isChatModel, parseModelSuggestions } from "./grok-models.js";
import { openCodeBackendLabel, type OpenCodeService } from "./opencode.js";

/* The xAI Grok provider adapter: same seam as agent.ts's runAgent. AgentRequest in, AgentEvent frames out,
 * backed by OpenCode (`@opencode-ai/sdk`) pointed at xAI Grok. OpenCode is itself the agentic runtime
 * (sessions, tools, file edits) and holds the OAuth credential; Grok is the model backend (providerID "xai").
 * Provider differences stay inside this file; the wire contract, routes, and UI are shared.
 *
 * Auth is subscription OAuth (SuperGrok / X Premium), driven by the Grok routes and persisted by OpenCode, no
 * per-turn key. The turn just resolves a session and streams. Permissions run allow-all because the container
 * is the isolation boundary (same posture as the Claude/Codex paths). */

// The xAI provider id in OpenCode / models.dev, and the default backend for a turn that names none.
const XAI = "xai";

// One Grok turn. Injected so tests drive a fake Event stream, no server, no network (the QueryFn/CodexRunner
// pattern). The runner creates/resumes the session and yields the OpenCode events for it.
export interface GrokTurn {
    readonly prompt: string;
    readonly sessionId?: string;
    readonly cwd: string;
    readonly model?: string;
    /* WHICH MODEL BACKEND OpenCode drives for this turn, its provider id, not ours. Absent ⇒ xAI, which is
     * what every Grok turn means and what this runtime served alone until Gemini arrived.
     *
     * It is per-TURN rather than per-runner because there is exactly one warm `opencode serve` per container and
     * both providers are registered on it (opencode.ts): the server is shared, the backend is a property of the
     * prompt. The xAI self-heal below is gated on this for the same reason, "Did you mean" is xAI's wording,
     * and its correction is recorded into xAI's catalog. */
    readonly provider?: string;
    // The built-in OpenCode agent: "plan" is read-only (proposes), "build" executes.
    readonly agent: "plan" | "build";
    /* THIS SANDBOX'S STANDING INSTRUCTIONS, as much of them as OpenCode will take, the whole of what makes
     * this runtime `instructions: "append"` rather than one that drops the setting silently.
     *
     * It rides `system` on the prompt body, which OpenCode ADDS to its own prompt: there is no seam for
     * replacing that base, so a custom system prompt arrives here as extra instructions and the settings page
     * says exactly that instead of promising a replacement two providers cannot perform.
     *
     * PER MESSAGE, not per session, because that is the only place the field exists, and it is why this is a
     * property of the turn like the model rather than of the runner. */
    readonly system?: string;
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
        // The watchdog counts this as life, a model that thinks for minutes before its first token emits
        // nothing else, and killing that turn at two minutes is the same false timeout this file already paid
        // for once. It is also where a retry (and with it a rate limit) announces itself; see streamTurn.
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

// A turn with no OpenCode event for OUR session for this long is treated as stuck and aborted. OpenCode can
// stall silently (e.g. while building a multimodal request) and emit neither session.idle nor session.error,
// which would otherwise hang the turn (no `done`) and spin the UI forever.
const GROK_INACTIVITY_MS = 120_000;

// Hard overall backstop: even if our session keeps dribbling events, one turn must not run forever.
const GROK_MAX_TURN_MS = 30 * 60_000;

// How long the event stream gets to say hello before the turn goes ahead without proof it is listening (see the
// connect handshake in the runner). Generous against a loaded host, but far short of the inactivity watchdog:
// waiting here costs latency on every turn, and going ahead early costs at most the session id.
const CONNECT_MS = 5_000;

// The production runner: use the shared OpenCode client to create/resume the session, fire the prompt on the
// xAI provider, and yield the session's events off the global SSE stream. `inactivityMs` is injectable for tests.
export const createGrokRunner = (openCode: OpenCodeService, inactivityMs: number = GROK_INACTIVITY_MS): GrokRunner =>
    async function* (turn) {
        const c = await openCode.client();
        // Subscribe BEFORE creating/prompting so the session.created + early part events aren't missed. Scoped
        // to this turn's directory because an unscoped stream carries no session events whatsoever, the whole
        // story is on subscribeEvents in opencode.ts.
        const sse = await openCode.events(turn.cwd);
        // A delegation this turn starts runs in this same directory, and its watcher is scoped the same way, so
        // register it here: the boot only knows the workspace root, and an isolated turn works in a worktree.
        // Idempotent, so every turn paying for it costs a Set lookup after the first.
        await openCode.watch(turn.cwd);
        /* SUBSCRIBING IS NOT CONNECTING, and the difference is a dropped session id.
         *
         * `subscribe()` builds a lazy generator, the HTTP request is not made until something READS it. So the
         * "subscribe first" above bought nothing on its own: the read used to start after the prompt, by which
         * time `session.created` had already been broadcast, and a brand-new session's id never reached the
         * client. That id is how the next message resumes this conversation instead of starting a fresh one.
         *
         * The first read is therefore issued and AWAITED here, before anything exists to miss: the server opens
         * every stream with `server.connected`, so that arriving is the proof the subscription is live. Whatever
         * it turns out to be is kept for the loop rather than dropped, this is a shared stream and a sibling
         * session's event can legitimately win the race. Bounded, because a server that never says hello must
         * cost this turn a couple of seconds rather than the turn. */
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
                    ...(modelId !== undefined && modelId !== "" ? { model: { providerID: turn.provider ?? XAI, modelID: modelId } } : {}),
                    ...(turn.system !== undefined ? { system: turn.system } : {}),
                    parts: [{ type: "text", text: turn.prompt }],
                },
            });
        // One self-heal attempt per turn: xAI names the account's valid models when it rejects a stale/renamed id.
        let retried = false;
        // After a self-heal re-prompt, a lingering session.idle from the FAILED prompt could end the turn before
        // the corrected one streams. While true, ignore idle until the retry's first real event proves it started.
        let awaitingRetryStart = false;
        /* THE SELF-HEAL IS xAI'S, both halves of it: "Did you mean: …" is xAI's own wording, and the correction is
         * recorded into xAI's catalog. A Gemini turn that tripped it would rewrite Grok's model list from a
         * sentence Google never wrote, so the whole mechanism is scoped to the backend it was built for. Gemini's
         * catalog comes off the translator and needs no rescue: a model it does not serve is not in it. */
        const selfHeals = (turn.provider ?? XAI) === XAI;
        // Fire the initial prompt. xAI rejects a stale/renamed (or seed) model id by REJECTING promptAsync (a thrown
        // ProviderModelNotFoundError) rather than via a session.error event, so the in-loop self-heal below never
        // sees it, heal it here the same way (record xAI's named models, re-prompt once with a valid one) so a
        // stale pinned/default model self-corrects silently instead of surfacing raw. A rejected prompt streamed no
        // events, so there's no stale idle to skip (no awaitingRetryStart needed).
        try {
            await sendPrompt(turn.model);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const suggestions = selfHeals && MODEL_INVALID.test(message) ? parseModelSuggestions(message).filter(isChatModel) : [];
            if (suggestions[0] === undefined) {
                throw error;
            }
            retried = true;
            await openCode.recordModels(suggestions);
            await sendPrompt(suggestions[0]);
        }
        // Drive the shared SSE iterator manually so each read can race an inactivity timeout (a `for await` can't),
        // and close it on exit (it's a per-turn subscription). Both session.idle and session.error are terminal,
        // OpenCode may not send idle after an error. The iterator and its first read were opened above, before
        // the session existed, so nothing this turn broadcast can have been missed.
        // Two independent bounds, measured against wall-clock deadlines rather than a fresh per-read timer: the
        // inactivity deadline advances only on OUR session's events (a busy sibling session on the shared stream
        // must not keep a wedged target turn's watchdog from firing), and the turn deadline is a hard backstop.
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
                        return;
                    }
                    event = result.value;
                    pending = iterator.next();
                }
                if (eventSessionId(event) !== sessionId) {
                    continue;
                }
                inactivityDeadline = Date.now() + inactivityMs;
                /* A RETRY IS A WAIT OPENCODE HAS ALREADY NAMED THE END OF, and the watchdog must respect it.
                 *
                 * OpenCode rides out a refused request (a 429 above all) inside the turn on its own escalating
                 * backoff, and announces each wait ONCE with the instant it will try again. Left at the ordinary
                 * two minutes, any backoff longer than that would be read as silence and the turn killed while it
                 * was doing exactly what it said it would, so the deadline moves out past the promised instant,
                 * still under the hard turn cap that bounds everything here. */
                if (event.type === "session.status" && event.properties.status.type === "retry") {
                    inactivityDeadline = Math.max(inactivityDeadline, event.properties.status.next + inactivityMs);
                }
                // Self-heal a stale/renamed model in-place, instead of surfacing the error and making the user
                // re-send: xAI's rejection NAMES the account's valid models (the authoritative catalog). Record
                // them (fixes the picker + every future turn) and re-prompt this same session once with a valid
                // one. Model-not-found is rejected before any content streams, so nothing is duplicated. A second
                // failure (retried already true) falls through and surfaces as a real error.
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
// self-heal, any other error stays uncoded (e.g. an auth rejection).
const MODEL_INVALID = /model not found|does not exist|no such model|did you mean/i;

/* THE PROVIDER SAID NO BECAUSE OF HOW MUCH HAS BEEN ASKED OF IT, an allowance, a quota, a rate.
 *
 * Worth telling apart from every other failure because the recovery is nothing but time: coded, the chat shows
 * it as a muted "wait and retry" notice with the reset instant, and, the part that matters more, it stops
 * offering Continue, which on a spent allowance re-fails on the press by construction.
 *
 * Google is the wording this is written from: an Antigravity account with no weekly headroom left refuses with
 * `RESOURCE_EXHAUSTED` / "You exceeded your current quota", and CLIProxyAPI hands that back once its own walk
 * across the account fleet has run out of credentials to try (translator.ts).
 *
 * It reads MORE wordings than the shared mentionsSpentAllowance does, that helper deliberately keeps "rate
 * limit" out, because on the Claude harness the phrase also appears in retries the CLI is still working
 * through, and reading one of those as a spent plan would park a turn that was about to succeed. Here it cannot:
 * OpenCode's own in-turn retries (the session.status waits above) are spent by the time a session.error is
 * emitted, so a refusal reaching this line is the last word rather than a stage of one. */
const RATE_LIMITED = /rate.?limit|resource.?exhausted|too many requests|\b429\b/i;

const isRateLimited = (message: string): boolean => mentionsSpentAllowance(message) || RATE_LIMITED.test(message);

// Plan phase holds back the assistant text (it becomes the plan) instead of streaming it; `sessionId` is the
// session to resume for the execute phase, captured from session.created (or the resumed id).
interface TurnCapture {
    sessionId?: string;
    planText?: string;
    // Set when the plan phase hit a session.error, so runGrokPlanTurn suppresses the plan frame, a failed turn
    // must not surface a "plan" (the error already streamed), even if partial/echoed text reached planText.
    errored?: boolean;
}

// Normalize one Grok turn's OpenCode Event stream onto AgentEvents, RETURNING what the turn captured, the plan
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
    // this same session stream, and a text Part carries no role, without this, the prompt echoes into planText/delta.
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
                // completed | error. An edit/write completion derives its diff from the (now-final) input, the
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
        } else if (event.type === "session.status" && event.properties.status.type === "retry") {
            /* THE TURN IS ALIVE AND WAITING ON THE PROVIDER, which is otherwise indistinguishable from a hang.
             *
             * OpenCode retries a refused request inside the turn and says so once per wait, carrying the
             * provider's own sentence and the instant of the next attempt. Nothing else is emitted meanwhile, so
             * without this the chat sits on a cycling "Thinking…" for the whole backoff, and the one move a
             * user makes against an apparent hang is Stop, the only move that throws the work away.
             *
             * `status: 429` is how the chat's line says WHY: a wait it can name as rate-limiting is a wait the
             * user can act on (come back later, or pick a model on another allowance), where "not responding"
             * sends them looking for a fault that isn't there. No maxAttempts. OpenCode publishes which attempt
             * it is on and no bound for it, and inventing one would be a promise the retry never made. */
            const status = event.properties.status;
            yield {
                kind: "provider_retry",
                attempt: status.attempt,
                nextAttemptAt: status.next,
                ...(isRateLimited(status.message) ? { status: 429 } : {}),
            };
        } else if (event.type === "session.error") {
            const message = errorText(event.properties.error);
            yield {
                kind: "error",
                message,
                ...(MODEL_INVALID.test(message)
                    ? { code: "grok-model-invalid" as const }
                    : isRateLimited(message)
                      ? { code: "rate_limit" as const }
                      : {}),
            };
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
// No `question` frames. OpenCode's permission channel maps to per-tool approvals, not multiple-choice
// clarifying questions; a dedicated ask-tool is the upgrade path. Declared as `questions: false` in this
// runtime's capability row, which is what the composer says out loud.
async function* runGrokPlanTurn(request: AgentRequest, runner: GrokRunner, provider: string): AsyncGenerator<AgentEvent> {
    // Both phases of the emulation carry the same standing instructions: they are two messages of ONE turn, and
    // a plan proposed under the owner's prompt that is then executed without it would be a different agent
    // doing the work than the one that agreed to it.
    const system = request.systemAppend;
    const planPhase: PlanPhase = async function* (prompt, sessionId) {
        const capture = yield* streamTurn(
            runner({
                prompt,
                ...(sessionId !== undefined ? { sessionId } : {}),
                cwd: request.cwd,
                ...(request.model !== undefined ? { model: request.model } : {}),
                provider,
                agent: "plan",
                ...(system !== undefined ? { system } : {}),
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
                provider,
                agent: "build",
                ...(system !== undefined ? { system } : {}),
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
export const createGrokAgent = (runner: GrokRunner, provider: string = XAI) =>
    async function* runGrokAgent(request: AgentRequest): AsyncGenerator<AgentEvent> {
        const prompt = withFileNote(request.prompt, request.attachments ?? []);
        const turn =
            request.permissionMode === "plan"
                ? runGrokPlanTurn({ ...request, prompt }, runner, provider)
                : streamTurn(
                      runner({
                          prompt,
                          ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
                          cwd: request.cwd,
                          ...(request.model !== undefined ? { model: request.model } : {}),
                          provider,
                          agent: "build",
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
                // A thrown model-not-found (promptAsync rejected and the runner couldn't self-heal it, no named
                // alternatives) gets the same code as the event path, so the client reloads the catalog and drops
                // the bad pinned model rather than showing the raw error.
                yield { kind: "error", message, ...(MODEL_INVALID.test(message) ? { code: "grok-model-invalid" as const } : {}) };
            }
        }
        yield { kind: "done" };
    };
