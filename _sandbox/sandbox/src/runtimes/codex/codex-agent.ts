import type { AgentEvent, AgentReply, AskQuestion, ToolCallLocation } from "@intentic/sandbox-contract";
import { createRequest } from "../../agent/tools/agent-requests.js";
import type { AgentRequest } from "../../agent/run/agent.js";
import { splitAttachments, withFileNote } from "../../agent/prompt/attachment-note.js";
import { unsentParameterFrame } from "../../agent/run/error-frames.js";
import { isUnsentParameterRefusalText, mentionsSpentAllowance } from "../../agent/providers/failure-sentences.js";
import { EXECUTE_PROMPT, type ExecutePhase, type PlanPhase, runPlanEmulation } from "../../agent/prompt/plan-emulation.js";
import { toolCategoryOf, workspacePath } from "../../agent/tools/tool-calls.js";
import { openBrowserSession } from "../../browser/sessions/browser-sessions.js";
import { ROUTED_BROWSER_SERVER } from "../../browser/tools/browser-tools.js";
import { type CommandGate, vendorSubject } from "../../guard/command-gate.js";
import { createTurnGate } from "../../guard/turn-gate.js";
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

// Codex provider adapter: same seam as agent.ts's runAgent (AgentRequest in, AgentEvent frames out), backed by the
// Codex CLI's app-server instead of the Claude Agent SDK. App-server publishes whole item completions plus lifecycle,
// usage, image-generation and compaction events. Approval requests stay disabled: the container is the isolation
// boundary, as with the Claude path's bypassPermissions.

// Codex's reasoning-effort scale uses "xhigh" where Intentic's shared scale uses "max".
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const reasoningEffort = (effort: string): CodexReasoningEffort | undefined => {
    if (effort === "max") {
        return "xhigh";
    }
    return EFFORT_LEVELS.has(effort) ? (effort as CodexReasoningEffort) : undefined;
};

// Explicit environment app-server inherits: undefined entries dropped, cli-kind credentials merged, CODEX_HOME pinned
// to the workspace auth/session store. CODEX_API_KEY is dropped here; only a turn that resolves a codexEndpoint sets
// it, or a daemon-side bearer would leak to native account turns too.
const codexEnv = (codexHome: string, cliEnv: Record<string, string> | undefined): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== "CODEX_API_KEY") {
            env[key] = value;
        }
    }
    return { ...env, ...cliEnv, CODEX_HOME: codexHome };
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
type CodexTurnBase = Pick<CodexTurn, "env" | "modelProvider" | "config" | "namespace">;

// Projects the browser layer's stdio MCP specs (built for the Claude SDK) into Codex's per-thread config instead of a
// second browser stack; SDK-instance servers are skipped, since app-server can't spawn a live object. Only env deltas
// from the inherited turn environment ride the config, to avoid re-serializing every credential.
const codexMcpConfig = (servers: AgentRequest["sdkServers"], inheritedEnv: Readonly<Record<string, string>>): Record<string, JsonValue> => {
    const config: Record<string, JsonValue> = {};
    for (const [name, server] of Object.entries(servers ?? {})) {
        if (server.type !== undefined && server.type !== "stdio") {
            continue;
        }
        const env =
            server.env === undefined
                ? undefined
                : Object.fromEntries(Object.entries(server.env).filter(([key, value]) => inheritedEnv[key] !== value));
        config[`mcp_servers.${name}`] = {
            command: server.command,
            ...(server.args === undefined ? {} : { args: server.args }),
            ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
            ...(server.timeout === undefined ? {} : { tool_timeout_sec: Math.ceil(server.timeout / 1_000) }),
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
const questionToolConfig = (request: AgentRequest): Readonly<Record<string, JsonValue>> => ({
    "tools.experimental_request_user_input.enabled": request.unattended !== true,
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

// Lends the turn's one steering queue to whichever phase is running: a plan turn is two app-servers with an approval
// pause between them, and pulling from the queue directly would deliver a mid-pause message to the phase that already
// closed. Drained here once; what arrives during the pause waits for the next phase's channel.
interface SteeringChannel {
    readonly steering: AsyncIterable<string>;
    readonly close: () => void;
}

const steeringRelay = (queue: AsyncIterable<string>): (() => SteeringChannel) => {
    const waiting: string[] = [];
    let wake: (() => void) | undefined;
    let drained = false;
    void (async () => {
        for await (const text of queue) {
            waiting.push(text);
            wake?.();
        }
        drained = true;
        wake?.();
    })();
    return () => {
        let closed = false;
        return {
            steering: {
                async *[Symbol.asyncIterator](): AsyncGenerator<string> {
                    for (;;) {
                        // A message still waiting when the phase closes stays queued for the next phase, not this
                        // closing one.
                        if (closed) {
                            return;
                        }
                        const next = waiting.shift();
                        if (next !== undefined) {
                            yield next;
                            continue;
                        }
                        if (drained) {
                            return;
                        }
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                        });
                        wake = undefined;
                    }
                },
            },
            close: () => {
                closed = true;
                wake?.();
            },
        };
    };
};

const threadOptions = (request: AgentRequest, sandboxMode: CodexSandboxMode, gated: boolean): CodexThreadOptions => {
    const effort = request.effort !== undefined ? reasoningEffort(request.effort) : undefined;
    return {
        workingDirectory: request.cwd,
        sandboxMode,
        // No approvals by default; `gated` flips it when the owner's rulebook has something it could refuse.
        approvalPolicy: gated ? "untrusted" : "never",
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(effort !== undefined ? { modelReasoningEffort: effort } : {}),
    };
};

// Flattens an MCP result's content blocks to plain text, like agent.ts's resultText.
const mcpResultText = (item: Extract<CodexItem, { type: "mcp_tool_call" }>): string => {
    if (item.error !== undefined) {
        return item.error.message;
    }
    const content = item.result?.content;
    if (!Array.isArray(content)) {
        return "";
    }
    return content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("");
};

// Matches Codex's in-turn stream-retry notice; not a real failure, and no backoff instant is reported.
const CODEX_STREAM_RETRY = /^Reconnecting\.\.\.\s*(\d+)\s*\/\s*(\d+)/;

// Matches an older Codex build's auto-compaction warning, so a pinned CLI doesn't redden a healthy turn.
const CODEX_COMPACTED = /long threads and multiple compactions/i;

// Classifies a Codex error message that is not actually a failure; both of Codex's error channels run through here so a
// notice reads the same either way. Undefined means a real failure.
const codexNotice = (message: string): AgentEvent | undefined => {
    const retry = CODEX_STREAM_RETRY.exec(message);
    if (retry !== null) {
        return { kind: "provider_retry", attempt: Number(retry[1]), maxAttempts: Number(retry[2]) };
    }
    if (CODEX_COMPACTED.test(message)) {
        return { kind: "compact", trigger: "auto" };
    }
    // An advisory isn't a failure: the turn still answers normally, so it must not mark the phase errored.
    return CODEX_ADVISORY.test(message) ? { kind: "error", code: "codex-advisory", message } : undefined;
};

// Codex's warning channel, which by construction carries advisories rather than failures: whatever it says, the turn
// runs on. So nothing here may redden the turn or offer to pick it back up; the worst case is a muted line. Undefined
// drops the warning entirely, for the one Codex raises about something this chat already did on purpose.
const codexWarning = (message: string): AgentEvent | undefined => {
    if (CODEX_MODEL_RESUMED_ELSEWHERE.test(message)) {
        return undefined;
    }
    // Shapes with a frame of their own (stream retry, auto-compaction) keep it; the rest become the muted line.
    return codexNotice(message) ?? { kind: "error", code: "codex-advisory", message };
};

// Wider than mentionsSpentAllowance since Codex's own retries are already spent by the time this matches.
const RATE_LIMITED = /rate.?limit|resource.?exhausted|too many requests|\b429\b/i;

const isRateLimited = (message: string): boolean => mentionsSpentAllowance(message) || RATE_LIMITED.test(message);

// Order matters: the parameter refusal is checked first, since `400 ... not supported on this model` would otherwise
// also match CODEX_MODEL_INVALID and wrongly drop the user's pinned model. This sandbox's own bad request reads as an
// outage, not a bad model pick.
const codexFailureFrame = (event: Extract<AgentEvent, { kind: "error" }>): AgentEvent => {
    if (isUnsentParameterRefusalText(event.message)) {
        return unsentParameterFrame(event.message);
    }
    // Coded so the client shows a muted reset countdown and holds the turn, not a red error with a 5s retry ladder.
    if (isRateLimited(event.message)) {
        return { ...event, code: "rate_limit" as const };
    }
    // Tags an unusable model so the client reloads the catalog and drops the bad pin, mirroring grok-model-invalid.
    return CODEX_MODEL_INVALID.test(event.message) ? { ...event, code: "codex-model-invalid" as const } : event;
};

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
    readonly imageArtifacts: ImageArtifactContext;
    readonly signal: AbortSignal;
    readonly conversationId?: string;
    readonly holdMessages?: boolean;
    readonly browser?: CodexBrowserContext;
    // One gate for the whole turn, so an "always" from planning still holds while executing.
    readonly gate?: CommandGate;
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
    const { id, wait } = createRequest("question", { kind: "question", requestId: "", cancelled: true }, context.conversationId);
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
                        content: [{ type: "text", text: mcpResultText(item) }],
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
            const notice = codexNotice(event.message);
            if (notice !== undefined) {
                yield notice;
                continue;
            }
            yield { kind: "error", message: event.message };
            capture.errored = true;
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

// Adds Codex's read-only planning truth to the shared plan-preamble wording.
const CODEX_PLAN_PREAMBLE =
    "Before making any changes, propose a clear, concise plan for the request below and stop: do not execute it yet. " +
    "You are in a read-only sandbox for this turn; end your reply with the plan itself.\n\n";

// Always-plan flow over the shared skeleton: a read-only planning turn whose trailing message becomes the plan, then a
// full-access execution turn resumed on the same thread. Each phase borrows its own steering channel and closes it on
// end, so a pause between them keeps queued messages.
async function* runCodexPlanTurn(
    request: AgentRequest,
    runner: CodexRunner,
    turnBase: CodexTurnBase,
    context: Omit<CodexStreamContext, "holdMessages" | "browser">,
    browser: Omit<CodexBrowserContext, "sessionId"> | undefined,
    channel: (() => SteeringChannel) | undefined,
): AsyncGenerator<AgentEvent> {
    const { images: firstTurnImages, others } = splitAttachments(request.attachments);
    // Images ride only the first planning turn; later turns resume the same thread that already holds them.
    let images = firstTurnImages;
    const phase = async function* (
        prompt: string,
        sessionId: string | undefined,
        sandboxMode: CodexSandboxMode,
        holdMessages: boolean,
    ): AsyncGenerator<AgentEvent, TurnCapture> {
        const steering = channel?.();
        try {
            return yield* streamTurn(
                runner({
                    prompt,
                    ...(images.length > 0 ? { images } : {}),
                    ...(sessionId !== undefined ? { sessionId } : {}),
                    ...turnBase,
                    ...(steering !== undefined ? { steering: steering.steering } : {}),
                    options: threadOptions(request, sandboxMode, context.gate?.enforcing === true),
                    signal: request.signal,
                }),
                {
                    ...context,
                    holdMessages,
                    ...(browser === undefined ? {} : { browser: { ...browser, ...(sessionId === undefined ? {} : { sessionId }) } }),
                },
            );
        } finally {
            steering?.close();
        }
    };
    const planPhase: PlanPhase = async function* (prompt, sessionId) {
        const capture = yield* phase(prompt, sessionId, "read-only", true);
        images = [];
        return { sessionId: capture.threadId, planText: capture.heldMessage, errored: capture.errored === true };
    };
    const executePhase: ExecutePhase = (sessionId) => phase(EXECUTE_PROMPT, sessionId, "danger-full-access", false);
    yield* runPlanEmulation(request.signal, CODEX_PLAN_PREAMBLE + withFileNote(request.prompt, others), request.sessionId, planPhase, executePhase);
}

interface CodexAgentOptions {
    readonly codexHome: string;
    readonly runner?: CodexRunner;
}

// Codex provider for the Services seam: AgentRequest in, AgentEvent frames out. Browser MCP, steering, question cards
// and the skill list all come from app-server; daemon-side SDK servers, plugins and server-initiated approvals stay
// absent.
export const createCodexAgent = (options: CodexAgentOptions) => {
    const runner = options.runner ?? createCodexAppServerRunner();
    return async function* runCodexAgent(request: AgentRequest): AsyncGenerator<AgentEvent> {
        // Per-account CODEX_HOME when resolved; a subscription turn's bearer rides CODEX_API_KEY instead.
        const activeCodexHome = request.codexHome ?? options.codexHome;
        const env = codexEnv(activeCodexHome, request.cliEnv);
        // Owner's system prompt and the daemon's additions, as the two config keys Codex reads them from. Merged under
        // the translator provider block, not over, so a future key added to either side can't silently win.
        const instructions = await codexInstructionConfig(request, activeCodexHome);
        const runtimeConfig = { ...instructions, ...questionToolConfig(request), ...codexMcpConfig(request.sdkServers, env) };
        const turnBase: CodexTurnBase = {
            ...(request.codexEndpoint !== undefined
                ? {
                      env: { ...env, CODEX_API_KEY: request.codexEndpoint.authToken },
                      ...withRuntimeConfig(translatorProvider(request.codexEndpoint.baseUrl), runtimeConfig),
                  }
                : { env, config: runtimeConfig }),
            // Anchors an isolated turn's worktree at /work for app-server and its forks; absent, the turn just runs
            // cwd'd.
            ...(request.isolation?.anchor === undefined
                ? {}
                : { namespace: { pid: request.isolation.anchor.pid, cwd: request.isolation.anchor.cwd } }),
        };
        // request.cwd is this conversation's own checkout; the shared root would misplace an isolated turn's image.
        const imageArtifacts = { workspaceRoot: request.cwd, codexHome: activeCodexHome };
        const browser =
            request.browserPorts === undefined
                ? undefined
                : {
                      ports: request.browserPorts,
                      passkeys: request.browserPasskeys ?? {},
                      accounts: request.browserAccounts ?? {},
                      ...(request.conversationId === undefined ? {} : { owner: request.conversationId }),
                  };
        // This run's one consumer of the steering queue; absent for a bench or benchmark run with no queue.
        const channel = request.steering === undefined ? undefined : steeringRelay(request.steering);
        // One gate for the whole run, so an "always" from planning still holds while executing.
        const { gate, release } = createTurnGate(request);
        const context: Omit<CodexStreamContext, "holdMessages" | "browser"> = {
            cwd: request.cwd,
            imageArtifacts,
            signal: request.signal,
            gate,
            ...(request.conversationId === undefined ? {} : { conversationId: request.conversationId }),
        };
        // If app-server reports an error and then dies, keep that frame over the generic process-exit wrapper.
        const { images, others } = splitAttachments(request.attachments);
        const steering = request.permissionMode === "plan" ? undefined : channel?.();
        const turn =
            request.permissionMode === "plan"
                ? runCodexPlanTurn(request, runner, turnBase, context, browser, channel)
                : streamTurn(
                      runner({
                          prompt: withFileNote(request.prompt, others),
                          ...(images.length > 0 ? { images } : {}),
                          ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
                          ...turnBase,
                          ...(steering !== undefined ? { steering: steering.steering } : {}),
                          options: threadOptions(request, "danger-full-access", gate.enforcing),
                          signal: request.signal,
                      }),
                      {
                          ...context,
                          holdMessages: false,
                          ...(browser === undefined
                              ? {}
                              : { browser: { ...browser, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }) } }),
                      },
                  );
        let surfacedError = false;
        try {
            for await (const event of turn) {
                if (event.kind === "error") {
                    // An advisory isn't a failure and must not count as the surfaced error, or a later real failure
                    // gets swallowed.
                    if (event.code === "codex-advisory") {
                        yield event;
                        continue;
                    }
                    surfacedError = true;
                    yield codexFailureFrame(event);
                    continue;
                }
                yield event;
            }
        } catch (error) {
            if (!surfacedError) {
                const message = error instanceof Error ? error.message : "codex agent failed";
                yield codexFailureFrame({ kind: "error", message });
            }
        } finally {
            // Its app-server is gone; leaving the channel open would park the steering pump on a promise nothing
            // resolves.
            steering?.close();
            // This turn's outside-content bit dies with it; the next turn starts clean unless it takes something in
            // too.
            release();
        }
        yield { kind: "done" };
    };
};
