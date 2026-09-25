import { type AgentEvent, type AgentReply, type AskQuestion, CODEX, type ToolCallContent, type ToolCallLocation } from "@intentic/sandbox-contract";
import { type SteeringChannel, steeringRelay } from "../../agent/checkpoints/agent-steering.js";
import type { AgentRequest, CodexCredential, TurnTools } from "../../agent/providers/agent-request.js";
import { splitAttachments, withFileNote } from "../../agent/prompt/attachment-note.js";
import { opt } from "../../opt.js";
import { type EmulatedPlan, EXECUTE_PROMPT, planMode } from "../decorators/plan-mode.js";
import { isRateLimited, vendorFailureFrame, type VendorRule } from "../decorators/vendor-errors.js";
import { isContextOverflowText } from "../../agent/providers/failure-sentences.js";
import { transientUpstream } from "../../agent/providers/routed-refusal.js";
import { resultContent, toolCategoryOf, workspacePath } from "../../agent/tools/tool-calls.js";
import { openBrowserSession } from "../../browser/sessions/browser-sessions.js";
import { workloadStamp } from "../../seams/workload-stamp.js";
import { ROUTED_BROWSER_SERVER } from "../../browser/tools/browser-tools.js";
import { type CommandGuard, vendorSubject } from "../../guard/command-guard.js";
import { vendorTurnGate } from "../decorators/vendor-gate.js";
import { codexUsageFromRateLimits } from "../../usage/translator-usage.js";
import {
    type CodexEvent,
    type CodexItem,
    type CodexQuestion,
    type CodexReasoningEffort,
    type CodexRunner,
    type CodexSandboxMode,
    type CodexThreadOptions,
    type CodexTurn,
    createCodexAppServerRunner,
    type JsonValue,
} from "./codex-app-server.js";
import { persistCodexImageArtifact } from "./codex-image-artifacts.js";
import { codexInstructionConfig } from "./codex-instructions.js";
import { CODEX_ADVISORY, CODEX_MODEL_INVALID, CODEX_MODEL_RESUMED_ELSEWHERE } from "./codex-models.js";
import type { ParkedCards } from "../../agents/actor/parked-cards.js";

// Codex provider adapter: same seam as agent.ts's runAgent (AgentRequest in, AgentEvent frames out), backed by the
// Codex CLI's app-server instead of the Claude Agent SDK. App-server publishes whole item completions plus lifecycle,
// usage, image-generation and compaction events. Approval requests stay disabled: the container is the isolation
// boundary, as with the Claude path's bypassPermissions.

// Codex names every rung of the shared scale, so a pick travels as picked; a level this build doesn't know is dropped
// rather than guessed at, leaving the model's own default to answer.
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
const reasoningEffort = (effort: string): CodexReasoningEffort | undefined =>
    EFFORT_LEVELS.has(effort) ? (effort as CodexReasoningEffort) : undefined;

// Explicit environment app-server inherits: undefined entries dropped, cli-kind credentials merged, CODEX_HOME pinned,
// and the owner stamp every turn workload carries. CODEX_API_KEY is dropped: only a turn that resolves a codexEndpoint
// sets it, or a daemon-side bearer would leak to native account turns too.
const codexEnv = (codexHome: string, cliEnv: Record<string, string> | undefined, conversationId: string | undefined): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== "CODEX_API_KEY") {
            env[key] = value;
        }
    }
    return { ...env, ...cliEnv, CODEX_HOME: codexHome, ...(conversationId === undefined ? {} : workloadStamp(conversationId)) };
};

// The translator provider block speaks Responses wire format with a fixed local bearer (env_key) and
// supports_websockets=false, since the translator's inbound is plain POST SSE. Merges a turn's instructions and MCP
// keys under the provider block, an order chosen once since the two sets never share a key.
const withRuntimeConfig = (
    provider: Pick<CodexTurn, "modelProvider" | "config">,
    instructions: Record<string, JsonValue>,
): Pick<CodexTurn, "modelProvider" | "config"> => ({ ...provider, config: { ...instructions, ...provider.config } });

// What every turn of one run shares: environment, provider block, and namespace. Only the prompt, sandbox mode and
// session id differ between turns.
type CodexTurnBase = Pick<CodexTurn, "env" | "modelProvider" | "config" | "namespace" | "spawnDepth">;

// Projects the turn's MCP servers into Codex's per-thread config: every remote mount (the daemon's MCP door's browsers,
// machines and extension tools, and the mcp-kind cards) as a Streamable HTTP server, the one list every runtime reads.
const codexMcpConfig = (tools: Pick<TurnTools, "remote">): Record<string, JsonValue> => {
    const config: Record<string, JsonValue> = {};
    for (const tool of tools.remote ?? []) {
        config[`mcp_servers.${tool.name}`] = {
            url: tool.url,
            ...(tool.token === undefined ? {} : { http_headers: { Authorization: `Bearer ${tool.token}` } }),
            ...(tool.timeoutMs === undefined ? {} : { tool_timeout_sec: Math.ceil(tool.timeoutMs / 1_000) }),
        };
    }
    return config;
};

const translatorProvider = (baseUrl: string): Pick<CodexTurn, "modelProvider" | "config"> => ({
    modelProvider: "translator",
    config: {
        "model_providers.translator": {
            name: "translator",
            base_url: `${baseUrl.replace(/\/$/, "")}/v1`,
            wire_api: "responses",
            env_key: "CODEX_API_KEY",
            // Non-secret marker Codex's image extension expects; the translator drops it and authenticates itself.
            http_headers: { "x-openai-actor-authorization": "intentic" },
            supports_websockets: false,
        },
    },
});

// Codex registers this tool whenever the config table is absent, so it's set explicitly every turn: on for an ordinary
// turn (the adapter answers the resulting card), off for an unattended one, where a card would deadlock the turn.
const questionToolConfig = (request: Pick<AgentRequest, "policy">): Readonly<Record<string, JsonValue>> => ({
    "tools.experimental_request_user_input.enabled": request.policy.unattended !== true,
});

// Always single-pick: Codex has no multi-select flag, and free-text answers already cover `isOther`. A secret is never
// put on a card, since a card's answers are recorded in the frame log and journal; the refusal points to the credential
// already in the turn's environment instead.
const askQuestion = (question: CodexQuestion): AskQuestion => ({
    question: question.question,
    header: question.header,
    multiSelect: false,
    options: question.options.map((option) => ({ label: option.label, description: option.description })),
});

const SECRET_REFUSED =
    "This client does not collect secrets on a question card, because a card's answers are recorded. " +
    "A credential the owner has connected is already in this turn's environment: read it from there, " +
    "or say which connection is missing and stop rather than asking anyone to paste one.";

const QUESTIONS_DISMISSED = "The user dismissed the questions without answering and stopped the turn.";

// One answer per question id, in the shape app-server is waiting for. A secret question is always refused; a dismissal
// answers every question the same way, since Codex is blocked on the reply.
const codexAnswers = (questions: readonly CodexQuestion[], reply: Extract<AgentReply, { kind: "question" }>): Record<string, readonly string[]> =>
    Object.fromEntries(
        questions.map((question) => {
            if (question.secret) {
                return [question.id, [SECRET_REFUSED]];
            }
            if (reply.cancelled || reply.answers === undefined) {
                return [question.id, [QUESTIONS_DISMISSED]];
            }
            return [question.id, reply.answers[question.question] ?? []];
        }),
    );

const threadOptions = (request: Pick<AgentRequest, "spec">, sandboxMode: CodexSandboxMode, gated: boolean): CodexThreadOptions => {
    const effort = request.spec.effort !== undefined ? reasoningEffort(request.spec.effort) : undefined;
    return {
        workingDirectory: request.spec.cwd,
        sandboxMode,
        // No approvals by default; `gated` flips it when the owner's rulebook has something it could refuse.
        approvalPolicy: gated ? "untrusted" : "never",
        ...(request.spec.model !== undefined ? { model: request.spec.model } : {}),
        ...(effort !== undefined ? { modelReasoningEffort: effort } : {}),
    };
};

// An MCP result read by the Claude stream's own rule (resultContent), so a Codex screenshot carries its picture too.
const mcpResultContent = (item: Extract<CodexItem, { type: "mcp_tool_call" }>, name: string, context: CodexStreamContext): ToolCallContent[] =>
    item.error === undefined
        ? resultContent(item.result?.content, context.cwd, context.browserOutputDir, item.status === "failed" ? undefined : { name, input: undefined })
        : [{ type: "text", text: item.error.message }];

// Matches Codex's in-turn stream-retry notice; not a real failure, and no backoff instant is reported.
const CODEX_STREAM_RETRY = /^Reconnecting\.\.\.\s*(\d+)\s*\/\s*(\d+)/;

// Codex's heads-up after every auto-compaction. The context_compaction item already carries the lifecycle frame, so
// repeating it here would show the reader two compaction notices for one compaction.
const CODEX_COMPACTED = /long threads and multiple compactions/i;

// Codex messages this chat swallows on any channel: each reports something already framed elsewhere, so neither an
// error nor a muted line may come of them.
const codexDropped = (message: string): boolean => CODEX_COMPACTED.test(message) || CODEX_MODEL_RESUMED_ELSEWHERE.test(message);

// Classifies a Codex error message that is not actually a failure; both of Codex's error channels run through here so a
// notice reads the same either way. Undefined means a real failure.
const codexNotice = (message: string): AgentEvent | undefined => {
    const retry = CODEX_STREAM_RETRY.exec(message);
    if (retry !== null) {
        return { kind: "provider_retry", attempt: Number(retry[1]), maxAttempts: Number(retry[2]) };
    }
    // An advisory isn't a failure: the turn still answers normally, so it must not mark the phase errored.
    return CODEX_ADVISORY.test(message) ? { kind: "error", code: "codex-advisory", message } : undefined;
};

// Codex's warning channel, which by construction carries advisories rather than failures: whatever it says, the turn
// runs on. So nothing here may redden the turn or offer to pick it back up; the worst case is a muted line. Undefined
// drops the warning entirely.
const codexWarning = (message: string): AgentEvent | undefined => {
    if (codexDropped(message)) {
        return undefined;
    }
    // Shapes with a frame of their own (stream retry) keep it; the rest become the muted line.
    return codexNotice(message) ?? { kind: "error", code: "codex-advisory", message };
};

// Codex's error channel, classified whole: the frames to emit, and whether the turn really died. A dropped message
// yields nothing at all, and only a message that classifies as neither notice nor advisory counts as a failure.
const codexError = (message: string): { frames: AgentEvent[]; errored: boolean } => {
    if (codexDropped(message)) {
        return { frames: [], errored: false };
    }
    const notice = codexNotice(message);
    return notice !== undefined ? { frames: [notice], errored: false } : { frames: [{ kind: "error", message }], errored: true };
};

// How Codex's failure sentences are coded, in this order: a spent allowance first, so the client shows a muted reset
// countdown and holds the turn, then an unusable model, so it reloads the catalog and drops the bad pin, then a thread
// past the model's window, which the daemon re-runs in a fresh one.
const CODEX_FAILURES: readonly VendorRule[] = [
    [isRateLimited, "rate_limit"],
    [(message) => CODEX_MODEL_INVALID.test(message), "codex-model-invalid"],
    [isContextOverflowText, "context-overflow"],
];

// Waits before re-running a turn the translator never got to the model, in ms: long enough for a stalled resolver or a
// refused dial to pass, short enough that the user is still watching. One entry per retry, so the list is the cap.
const UPSTREAM_WAITS_MS = [3_000, 8_000] as const;
const UPSTREAM_ATTEMPTS = UPSTREAM_WAITS_MS.length + 1;

// The wait before re-running, or undefined when this failure is the turn's answer. Only a transport or capacity failure
// earns a re-run: the proxy files its credential away for one of those and then refuses in the words of a plan that
// excludes the model, so the sentence alone would end a turn the next call would serve. A spent allowance is ruled out
// first, since it belongs in a countdown the user waits out, not in a ladder that spends attempts on the same refusal.
const upstreamWaitMs = (attempt: number, message: string): number | undefined =>
    !isRateLimited(message) && transientUpstream(message) ? UPSTREAM_WAITS_MS[attempt - 1] : undefined;

// Frames a turn emits before it does any work: its thread id, its skill list, its usage and limit snapshots. Anything
// else means a re-run would repeat work the user has already seen.
const TURN_BOOKKEEPING = new Set<AgentEvent["kind"]>([
    "session",
    "commands",
    "usage",
    "rate_limit_info",
    "account_usage",
    "context_usage",
    "init",
    "mode",
    "provider_retry",
]);

// One attempt's frames, plus what to do after it: the failure it surfaced, or the wait before re-running when the
// translator never reached the model. `surfaced` carries in what earlier attempts already showed.
interface AttemptOutcome {
    readonly surfaced?: string;
    readonly waitMs?: number;
}

const attemptOutcome = (surfaced: string | undefined, waitMs?: number): AttemptOutcome => ({
    ...(surfaced === undefined ? {} : { surfaced }),
    ...(waitMs === undefined ? {} : { waitMs }),
});

// An advisory rides the same channel as a failure without being one: it must never count as the surfaced error, or the
// real failure that follows arrives silent.
const isCodexFailure = (event: AgentEvent): event is Extract<AgentEvent, { kind: "error" }> =>
    event.kind === "error" && event.code !== "codex-advisory";

const thrownMessage = (error: unknown): string => (error instanceof Error ? error.message : "codex agent failed");

// Waits out a retry's backoff, and stops waiting the moment the turn is cancelled: a turn nobody is waiting for must
// not hold the run open for the rest of its wait.
const waitFor = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });

async function* consumeAttempt(
    turn: AsyncGenerator<AgentEvent>,
    attempt: number,
    surfaced: string | undefined,
): AsyncGenerator<AgentEvent, AttemptOutcome> {
    let shown = surfaced;
    // A re-run re-sends the prompt, so only an attempt that produced nothing may be retried.
    let produced = false;
    try {
        for await (const event of turn) {
            if (!isCodexFailure(event)) {
                produced ||= !TURN_BOOKKEEPING.has(event.kind);
                yield event;
                continue;
            }
            const waitMs = produced ? undefined : upstreamWaitMs(attempt, event.message);
            if (waitMs !== undefined) {
                return attemptOutcome(shown, waitMs);
            }
            if (shown === undefined) {
                shown = event.message;
                yield vendorFailureFrame(event, CODEX_FAILURES);
            }
        }
    } catch (error) {
        // The app-server died: its own message stands only when the turn hasn't already said what went wrong.
        if (shown === undefined) {
            shown = thrownMessage(error);
            yield vendorFailureFrame({ kind: "error", message: shown }, CODEX_FAILURES);
        }
    }
    return attemptOutcome(shown);
}

// What phase 1 of a plan turn holds back: the thread id to resume for execution, and the trailing message the user
// approves as the plan.
interface TurnCapture {
    threadId?: string;
    heldMessage?: string;
    // Set when the plan phase failed, so a failed turn never surfaces a plan even if a message was held.
    errored?: boolean;
}

interface ImageArtifactContext {
    readonly workspaceRoot: string;
    readonly codexHome: string;
}

interface CodexBrowserContext {
    readonly ports: Readonly<Record<string, number>>;
    readonly passkeys: Readonly<Record<string, string>>;
    // Routed browser server's account→owner map; a routed call attributes only when every route shares one owner.
    readonly accounts: Readonly<Record<string, string>>;
    readonly owner?: string;
    // Present only on a resumed invocation; a new thread learns its id from thread.started first.
    readonly sessionId?: string;
}

// The one profile a routed call can be pinned to without seeing its arguments; defined only if every account maps to
// the same owner.
const soleRoutedOwner = (browser: CodexBrowserContext | undefined): string | undefined => {
    const owners = new Set(Object.values(browser?.accounts ?? {}));
    return owners.size === 1 ? [...owners][0] : undefined;
};

// Ties a browser call to the profile whose session drives it, so opened pages belong to that account. A routed server's
// calls carry no account in the item, so they attach only when the turn resolves to a single profile.
const attachBrowserSession = (
    item: Extract<CodexItem, { type: "mcp_tool_call" }>,
    threadId: string | undefined,
    browser: CodexBrowserContext | undefined,
): void => {
    if (browser === undefined || !item.tool.startsWith("browser_")) {
        return;
    }
    const profile = item.server === ROUTED_BROWSER_SERVER ? soleRoutedOwner(browser) : item.server;
    const port = profile === undefined ? undefined : browser.ports[profile];
    const sessionId = threadId ?? browser.sessionId;
    if (profile === undefined || port === undefined || sessionId === undefined) {
        return;
    }
    openBrowserSession({ sessionId, server: profile, port, passkeyStore: browser.passkeys[profile], owner: browser.owner });
};

// Context one Codex turn's stream normalizes against: cwd, where generated images land, the question-card signal and
// dismissal target. `holdMessages` is the plan phase's one behavioral difference.
interface CodexStreamContext {
    readonly cwd: string;
    // Where a question card is parked, so the reply finds it.
    readonly cards: Pick<ParkedCards, "create">;
    readonly imageArtifacts: ImageArtifactContext;
    // Where this turn's screenshots land; absent on a turn with no browser tools.
    readonly browserOutputDir?: string;
    readonly signal: AbortSignal;
    readonly conversationId?: string;
    readonly holdMessages?: boolean;
    readonly browser?: CodexBrowserContext;
    // One gate for the whole turn, so an "always" from planning still holds while executing.
    readonly gate?: CommandGuard;
}

// Same card, registry and dismissal the `ask` tool uses, so a question reads the same across runtimes. The stream parks
// on the await (app-server is blocked on it too), and the resolved frame goes out before the answer, to freeze the card
// in a replayed transcript.
async function* codexQuestionCard(
    request: Extract<CodexEvent, { type: "user_input.requested" }>,
    context: CodexStreamContext,
): AsyncGenerator<AgentEvent> {
    const asked = request.questions.filter((question) => !question.secret);
    if (asked.length === 0) {
        request.respond(Object.fromEntries(request.questions.map((question) => [question.id, [SECRET_REFUSED]])));
        return;
    }
    const { id, wait } = context.cards.create("question", { kind: "question", requestId: "", cancelled: true }, context.conversationId);
    yield { kind: "question", requestId: id, questions: asked.map(askQuestion) };
    const { reply, resolved } = await wait(context.signal);
    yield resolved;
    request.respond(codexAnswers(request.questions, reply));
}

// Same parking trick as codexQuestionCard: app-server is blocked on this request too. A refusal declines rather than
// cancels, since Codex's `cancel` interrupts the whole turn, and a refused command should just make the agent try
// something else.
async function* codexCommandApproval(
    request: Extract<CodexEvent, { type: "command_approval.requested" }>,
    context: CodexStreamContext,
): AsyncGenerator<AgentEvent> {
    if (context.gate === undefined) {
        request.respond(true);
        return;
    }
    const outcome = yield* context.gate.consult(request.command, vendorSubject("Bash"));
    request.respond(outcome.allow);
}

// Normalizes one Codex turn onto AgentEvents and returns what it captured (read via `yield*` by the plan phase,
// discarded by an ordinary turn). `holdMessages` holds agent messages one-deep, flushing each as the next arrives, so
// whatever remains at the end is the plan text.
async function* streamTurn(events: AsyncIterable<CodexEvent>, context: CodexStreamContext): AsyncGenerator<AgentEvent, TurnCapture> {
    const { cwd, imageArtifacts, browser, holdMessages = false } = context;
    const capture: TurnCapture = {};
    for await (const event of events) {
        if (event.type === "thread.started") {
            capture.threadId = event.thread_id;
            yield { kind: "session", sessionId: event.thread_id };
        } else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
            const item = event.item;
            if (item.type === "agent_message") {
                if (event.type !== "item.completed") {
                    continue;
                }
                // Whole blocks only (item.completed): text_end follows at once, so later tool calls render under this
                // bubble.
                if (!holdMessages) {
                    yield { kind: "delta", text: item.text };
                    yield { kind: "text_end" };
                    continue;
                }
                // Held one message deep: flushed the instant a newer one arrives, so only the last stays held as the
                // plan.
                if (capture.heldMessage !== undefined) {
                    yield { kind: "delta", text: capture.heldMessage };
                    yield { kind: "text_end" };
                }
                capture.heldMessage = item.text;
            } else if (item.type === "reasoning") {
                if (event.type === "item.completed") {
                    yield { kind: "thinking", text: item.text };
                }
            } else if (item.type === "command_execution") {
                if (event.type === "item.started") {
                    yield { kind: "tool_call", id: item.id, name: "Bash", category: "execute", status: "in_progress", target: item.command };
                } else if (event.type === "item.updated") {
                    // item.updated carries the full output so far, matching the update frame's replace semantics.
                    yield { kind: "tool_call_update", id: item.id, content: [{ type: "text", text: item.aggregated_output }] };
                } else if (event.type === "item.completed") {
                    const failed = item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
                    yield {
                        kind: "tool_call_update",
                        id: item.id,
                        status: failed ? "failed" : "completed",
                        content: [{ type: "text", text: item.aggregated_output }],
                    };
                }
            } else if (item.type === "file_change") {
                // Emitted once, success or failure; item has paths but no diff text, so the card shows locations only.
                if (event.type === "item.completed") {
                    const locations = item.changes
                        .map((change) => workspacePath(change.path, cwd))
                        .filter((path): path is string => path !== undefined)
                        .map((path): ToolCallLocation => ({ path }));
                    const allDeletes = item.changes.length > 0 && item.changes.every((change) => change.kind === "delete");
                    yield {
                        kind: "tool_call",
                        id: item.id,
                        name: "Edit",
                        category: allDeletes ? "delete" : "edit",
                        status: item.status === "failed" ? "failed" : "completed",
                        target: item.changes.map((change) => `${change.kind} ${change.path}`).join(", "),
                        ...(locations.length > 0 ? { locations } : {}),
                        ...(item.status === "failed" ? { content: [{ type: "text", text: "patch failed" }] } : {}),
                    };
                }
            } else if (item.type === "mcp_tool_call") {
                const name = `${item.server}.${item.tool}`;
                if (event.type === "item.started") {
                    attachBrowserSession(item, capture.threadId, browser);
                    yield { kind: "tool_call", id: item.id, name, category: toolCategoryOf(name), status: "in_progress" };
                } else if (event.type === "item.completed") {
                    yield {
                        kind: "tool_call_update",
                        id: item.id,
                        status: item.status === "failed" ? "failed" : "completed",
                        content: mcpResultContent(item, name, context),
                    };
                }
            } else if (item.type === "web_search") {
                if (event.type === "item.completed") {
                    yield { kind: "tool_call", id: item.id, name: "WebSearch", category: "search", status: "completed", target: item.query };
                }
            } else if (item.type === "todo_list") {
                yield {
                    kind: "todos",
                    items: item.items.map((todo) => ({ content: todo.text, status: todo.completed ? ("completed" as const) : ("pending" as const) })),
                };
            } else if (item.type === "image_generation") {
                if (event.type === "item.started") {
                    yield {
                        kind: "tool_call",
                        id: item.id,
                        name: "Image generation",
                        category: "other",
                        status: "in_progress",
                        ...(item.revised_prompt !== undefined ? { target: item.revised_prompt } : {}),
                    };
                    continue;
                }
                // Nothing to say while running; the completion event below settles the card.
                if (event.type !== "item.completed") {
                    continue;
                }
                if (item.status !== "completed") {
                    yield { kind: "tool_call_update", id: item.id, status: "failed", content: [{ type: "text", text: "Image generation failed" }] };
                    continue;
                }
                try {
                    const path = await persistCodexImageArtifact({ ...imageArtifacts, image: item });
                    yield { kind: "tool_call_update", id: item.id, status: "completed", content: [{ type: "image", path }] };
                } catch (error) {
                    yield {
                        kind: "tool_call_update",
                        id: item.id,
                        status: "failed",
                        content: [{ type: "text", text: error instanceof Error ? error.message : "Could not save generated image" }],
                    };
                }
            } else if (item.type === "context_compaction" && event.type === "item.completed") {
                yield { kind: "compact", trigger: "auto" };
            }
        } else if (event.type === "commands") {
            // Thread's skills for the `/` popover; republished every turn so an unused conversation still shows them.
            yield { kind: "commands", items: event.skills.map((skill) => ({ name: skill.name, description: skill.description })) };
        } else if (event.type === "user_input.requested") {
            yield* codexQuestionCard(event, context);
        } else if (event.type === "command_approval.requested") {
            yield* codexCommandApproval(event, context);
        } else if (event.type === "turn.completed") {
            if (event.usage !== undefined) {
                yield {
                    kind: "usage",
                    inputTokens: event.usage.input_tokens,
                    outputTokens: event.usage.output_tokens,
                    cacheReadTokens: event.usage.cached_input_tokens,
                    cacheCreationTokens: event.usage.cache_write_input_tokens,
                };
            }
        } else if (event.type === "rate_limits") {
            // Headroom pushed as the turn spends it; a snapshot with no window yields no frame, not a false "no
            // limits".
            const usage = codexUsageFromRateLimits(event.snapshot);
            if (usage !== undefined) {
                yield { kind: "account_usage", windows: usage.windows };
            }
        } else if (event.type === "turn.failed") {
            yield { kind: "error", message: event.error.message };
            capture.errored = true;
        } else if (event.type === "error") {
            const failure = codexError(event.message);
            yield* failure.frames;
            capture.errored ||= failure.errored;
        } else if (event.type === "warning") {
            // Never sets `errored`: a warned turn still answers, and a plan phase that holds its message must still
            // hand it over.
            const notice = codexWarning(event.message);
            if (notice !== undefined) {
                yield notice;
            }
        }
        // turn.started has no UI mapping and is dropped, like the Claude path's unmapped SDK messages.
    }
    return capture;
}

// The request a Codex loop runs: the subscription through the translator, or the container's own OPENAI_API_KEY.
type CodexRequest = AgentRequest<CodexCredential>;

// One app-server run of a phase: its prompt and pictures, the thread it resumes, and the sandbox it runs in. It borrows
// its own steering channel and closes it on end, so a pause between phases keeps queued messages.
interface CodexPhase {
    readonly prompt: string;
    readonly images: readonly string[];
    readonly sessionId: string | undefined;
    readonly sandboxMode: CodexSandboxMode;
    readonly holdMessages: boolean;
}

const codexPhase = (
    request: CodexRequest,
    runner: CodexRunner,
    turnBase: CodexTurnBase,
    context: Omit<CodexStreamContext, "holdMessages" | "browser">,
    browser: Omit<CodexBrowserContext, "sessionId"> | undefined,
    channel: (() => SteeringChannel) | undefined,
) =>
    async function* (phase: CodexPhase): AsyncGenerator<AgentEvent, TurnCapture> {
        const steering = channel?.();
        try {
            return yield* streamTurn(
                runner({
                    prompt: phase.prompt,
                    ...(phase.images.length > 0 ? { images: phase.images } : {}),
                    ...(phase.sessionId !== undefined ? { sessionId: phase.sessionId } : {}),
                    ...turnBase,
                    ...(steering !== undefined ? { steering: steering.steering } : {}),
                    options: threadOptions(request, phase.sandboxMode, context.gate?.enforcing === true),
                    signal: request.signal,
                }),
                {
                    ...context,
                    holdMessages: phase.holdMessages,
                    ...(browser === undefined
                        ? {}
                        : { browser: { ...browser, ...(phase.sessionId === undefined ? {} : { sessionId: phase.sessionId }) } }),
                },
            );
        } finally {
            // Leaving the channel open would park the steering pump on a promise nothing resolves.
            steering?.close();
        }
    };

// Adds Codex's read-only planning truth to the shared plan-preamble wording.
const CODEX_PLAN_PREAMBLE =
    "Before making any changes, propose a clear, concise plan for the request below and stop: do not execute it yet. " +
    "You are in a read-only sandbox for this turn; end your reply with the plan itself.\n\n";

// Plan flow over the shared skeleton: a read-only planning turn whose trailing message becomes the plan, then a
// full-access execution turn resumed on the same thread. Pictures ride only the first planning turn; later turns resume
// the thread that already holds them.
const codexPlan = (request: CodexRequest, phase: ReturnType<typeof codexPhase>): EmulatedPlan => {
    const { images: firstImages, others } = splitAttachments(request.spec.attachments);
    let images: readonly string[] = firstImages;
    return {
        prompt: CODEX_PLAN_PREAMBLE + withFileNote(request.spec.prompt, others),
        async *plan(prompt, sessionId) {
            const capture = yield* phase({ prompt, images, sessionId, sandboxMode: "read-only", holdMessages: true });
            images = [];
            return { sessionId: capture.threadId, planText: capture.heldMessage, errored: capture.errored === true };
        },
        execute: (sessionId) => phase({ prompt: EXECUTE_PROMPT, images, sessionId, sandboxMode: "danger-full-access", holdMessages: false }),
    };
};

interface CodexAgentOptions {
    readonly codexHome: string;
    readonly runner?: CodexRunner;
}

// Codex provider for the Services seam: AgentRequest in, AgentEvent frames out. Browser MCP, steering, question cards
// and the skill list all come from app-server; daemon-side SDK servers, plugins and server-initiated approvals stay
// absent.
export const createCodexAgent = (options: CodexAgentOptions) => {
    const runner = options.runner ?? createCodexAppServerRunner();
    return async function* runCodexAgent(request: CodexRequest): AsyncGenerator<AgentEvent> {
        // The sandbox-wide CODEX_HOME; a subscription turn's bearer rides CODEX_API_KEY instead.
        const activeCodexHome = options.codexHome;
        const env = codexEnv(activeCodexHome, request.tools.cliEnv, request.spec.conversationId);
        // Owner's system prompt and the daemon's additions, as the two config keys Codex reads them from. Merged under
        // the translator provider block, not over, so a future key added to either side can't silently win.
        const instructions = await codexInstructionConfig(request.spec, activeCodexHome);
        const runtimeConfig = { ...instructions, ...questionToolConfig(request), ...codexMcpConfig(request.tools) };
        const credential = request.credential;
        const turnBase: CodexTurnBase = {
            ...(credential.kind === "codex-endpoint"
                ? {
                      env: { ...env, CODEX_API_KEY: credential.authToken },
                      ...withRuntimeConfig(translatorProvider(credential.baseUrl), runtimeConfig),
                  }
                : { env, config: runtimeConfig }),
            // Anchors an isolated turn's worktree at /work for app-server and its forks; absent, the turn just runs
            // cwd'd.
            ...(request.spec.isolation?.anchor === undefined
                ? {}
                : { namespace: { pid: request.spec.isolation.anchor.pid, cwd: request.spec.isolation.anchor.cwd } }),
            ...opt("spawnDepth", request.spec.spawnDepth),
        };
        // request.spec.cwd is this conversation's own checkout; the shared root would misplace an isolated turn's image.
        const imageArtifacts = { workspaceRoot: request.spec.cwd, codexHome: activeCodexHome };
        const browser =
            request.tools.browserPorts === undefined
                ? undefined
                : {
                      ports: request.tools.browserPorts,
                      passkeys: request.tools.browserPasskeys ?? {},
                      accounts: request.tools.browserAccounts ?? {},
                      ...(request.spec.conversationId === undefined ? {} : { owner: request.spec.conversationId }),
                  };
        // This run's one consumer of the steering queue; absent for a bench or benchmark run with no queue.
        const channel = request.spec.steering === undefined ? undefined : steeringRelay(request.spec.steering);
        // One gate for the whole run, so an "always" from planning still holds while executing.
        const { gate, release } = vendorTurnGate(request);
        const context: Omit<CodexStreamContext, "holdMessages" | "browser"> = {
            cwd: request.spec.cwd,
            cards: request.hooks.cards,
            imageArtifacts,
            ...opt("browserOutputDir", request.tools.browserOutputDir),
            signal: request.signal,
            gate,
            ...(request.spec.conversationId === undefined ? {} : { conversationId: request.spec.conversationId }),
        };
        const { images, others } = splitAttachments(request.spec.attachments);
        const phase = codexPhase(request, runner, turnBase, context, browser, channel);
        // One whole attempt at the turn: a retry runs a new app-server, and the steering channel each phase borrows dies
        // with the process it was borrowed for.
        const runAttempt = (): AsyncGenerator<AgentEvent> =>
            planMode(
                CODEX,
                request,
                () => codexPlan(request, phase),
                () =>
                    phase({
                        prompt: withFileNote(request.spec.prompt, others),
                        images,
                        sessionId: request.spec.sessionId,
                        sandboxMode: "danger-full-access",
                        holdMessages: false,
                    }),
            );
        // The failure this run has already put in front of the user, carried across attempts: Codex reports one failure
        // on both of its channels and then dies, and no repeat of it may redden the turn again.
        let surfaced: string | undefined;
        try {
            for (let attempt = 1; ; attempt += 1) {
                const outcome = yield* consumeAttempt(runAttempt(), attempt, surfaced);
                surfaced = outcome.surfaced;
                if (outcome.waitMs === undefined) {
                    break;
                }
                yield { kind: "provider_retry", attempt, maxAttempts: UPSTREAM_ATTEMPTS, nextAttemptAt: Date.now() + outcome.waitMs };
                await waitFor(outcome.waitMs, request.signal);
                // A turn cancelled while it waited has no second attempt to run.
                if (request.signal?.aborted === true) {
                    break;
                }
            }
        } finally {
            // This turn's outside-content bit dies with it; the next turn starts clean unless it takes something in
            // too.
            release();
        }
        yield { kind: "done" };
    };
};
