import {
    createSdkMcpServer,
    type EffortLevel,
    type McpServerConfig,
    type Options,
    type PermissionMode,
    query,
    type SDKMessage,
    tool,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AskQuestion, TodoItem } from "@intentic/sandbox-contract";
import { z } from "zod";
import { type AgentTool, mcpServersOf } from "../workspace/tools.js";
import { createPlanRequest, createQuestionRequest, type QuestionResponse } from "./agent-requests.js";
import { agentSessionName, bashTmuxHooks, tmuxRunEnabled } from "./agent-terminals.js";

export interface AgentRequest {
    readonly prompt: string;
    // Absolute paths of user-attached files, consumed by the CODEX adapter (images ride as native
    // local_image inputs). The Claude path folds these into the prompt in streamAgent instead — its Read
    // tool handles images/PDFs from disk natively.
    readonly attachments?: readonly string[];
    // The working dir the agent edits — the workspace root, so it can touch all three repos.
    readonly cwd: string;
    // Resume a prior turn's session for multi-message conversations.
    readonly sessionId?: string;
    readonly signal: AbortSignal;
    // Defaults to the account/subscription default; override with INTENTIC_AGENT_MODEL.
    readonly model?: string;
    // The user's Claude subscription token, injected into the SDK for this turn. Resolved by the daemon from
    // the sandbox's own stored credentials (the platform no longer relays it); undefined falls back to the
    // container's ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN env.
    readonly oauthToken?: string;
    // The selected Codex account's CODEX_HOME for this turn (Codex path only). Absent ⇒ the adapter's default
    // base dir, which resolves the container's OPENAI_API_KEY fallback.
    readonly codexHome?: string;
    // Defaults to the autonomous sandbox posture; the container's isolation is what makes this safe.
    readonly permissionMode?: PermissionMode;
    // When true, run the always-plan flow: propose an approach via ExitPlanMode and wait for approval
    // before executing (tools then auto-accept). Clarifying questions are asked via AskUserQuestion.
    readonly plan?: boolean;
    // Reasoning controls forwarded to the SDK (effort level / extended thinking).
    readonly effort?: string;
    readonly thinking?: boolean;
    // The agent's MCP tools for this turn: intent-declared internal services (set in this container's env) plus
    // platform-configured external integrations. Each becomes a remote `http` MCP server. The daemon merges
    // both sources before calling; absent ⇒ the agent runs with no MCP tools (its plain autonomous posture).
    readonly tools?: readonly AgentTool[];
    // Env vars for the agent's shell from cli-kind capabilities (e.g. DISCORD_BOT_TOKEN) — the stored
    // credentials their CLI tools read. Merged into the SDK `env` each turn; absent ⇒ no extra env.
    readonly cliEnv?: Record<string, string>;
    // Absolute Claude Code plugin checkout dirs from plugin-kind capabilities, rebuilt each turn (see
    // pluginDirsOf). The SDK's plugin loader parses their skills/agents/hooks/commands/.mcp.json — the daemon
    // never does, so the plugin format tracks Claude Code via SDK upgrades alone.
    readonly plugins?: readonly string[];
    // In-process SDK MCP servers — daemon-side tools whose handlers run in the daemon itself (e.g. the
    // Discord voice session tools). Merged into mcpServers alongside the remote `tools` above.
    readonly sdkServers?: Record<string, McpServerConfig>;
    // Built-in tool names to remove from the model's context this turn (SDK disallowedTools). Set by the
    // hashlineEdits toggle to disable native Edit/Write so file mutations route through the hashline MCP tools.
    readonly disallowedTools?: readonly string[];
    // Extra turn-scoped instructions appended to the claude_code preset system prompt (e.g. the CLI
    // delegation note when Codex/Grok accounts are connected — see agent/delegation.ts).
    readonly systemAppend?: string;
}

// The SDK `query` is injected so tests drive a fake message stream — no API calls, no bundled binary.
export type QueryFn = (args: { readonly prompt: string; readonly options: Options }) => AsyncIterable<SDKMessage>;
const defaultQuery: QueryFn = (args) => query(args);

// The file path (Read/Write/Edit) or command (Bash) a tool acts on, for the `tool` event's target.
const toolTarget = (input: unknown): string | undefined => {
    if (typeof input !== "object" || input === null) {
        return undefined;
    }
    const record = input as Record<string, unknown>;
    const path = record["file_path"];
    if (typeof path === "string") {
        return path;
    }
    const command = record["command"];
    return typeof command === "string" ? command : undefined;
};

// Flatten a tool_result block's content (a string, or an array of text/other blocks) to plain text — the
// edit diff / bash output the UI shows under the tool card. Non-text blocks are summarised by type.
const resultText = (content: unknown): string => {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .map((block) => {
            const b = block as { type?: string; text?: string };
            return b.type === "text" && typeof b.text === "string" ? b.text : `[${b.type ?? "block"}]`;
        })
        .join("");
};

// Pull the TodoWrite/Task checklist off a tool_use input, or undefined if the shape doesn't match.
const todoItems = (input: unknown): TodoItem[] | undefined => {
    const todos = (input as { todos?: unknown }).todos;
    if (!Array.isArray(todos)) {
        return undefined;
    }
    return todos.map((t) => {
        const item = t as { content?: unknown; status?: unknown; activeForm?: unknown };
        const todo: TodoItem = {
            content: String(item.content ?? ""),
            status: item.status === "in_progress" || item.status === "completed" ? item.status : "pending",
        };
        if (typeof item.activeForm === "string") {
            todo.activeForm = item.activeForm;
        }
        return todo;
    });
};

// Normalize the SDK's SDKMessage stream onto AgentEvents. High-value block types get a dedicated frame;
// any SDK message without a mapping is dropped. Shared by the plain and plan paths; does NOT emit the
// terminal `done` (callers do that once the whole turn settles).
async function* streamSdk(queryFn: QueryFn, prompt: string, options: Options, tmuxEnabled: boolean): AsyncGenerator<AgentEvent> {
    let sessionSent = false;
    let terminalSent = false;
    // The agent's live tmux terminal is surfaced twice: once at the first Bash tool_use (so a long command is
    // watchable live) and once at that command's tool_result (by then tmux-run has definitely created the
    // session, so a first-command cold-start that outran the tool_use relist still gets a tab). surface() is
    // idempotent, so the double emit is harmless.
    let terminalResurfaced = false;
    let agentSession: string | undefined;
    const bashToolIds = new Set<string>();
    // Context-window fill for the turn: the latest message_start reports the request's input size (grows
    // monotonically within a turn); the result reports the model's contextWindow. Paired into one
    // context_usage frame at the result so the UI can warn as the chat nears auto-compaction.
    let contextTokens: number | undefined;
    let contextModel: string | undefined;
    for await (const message of queryFn({ prompt, options })) {
        const sessionId = (message as { session_id?: string }).session_id;
        if (!sessionSent && typeof sessionId === "string" && sessionId !== "") {
            sessionSent = true;
            yield { kind: "session", sessionId };
        }
        // Frames produced inside a subagent (Task tool) carry its id so the UI can group them.
        const parent = (message as { parent_tool_use_id?: string | null }).parent_tool_use_id ?? undefined;
        const withParent = parent !== undefined ? { parentToolUseId: parent } : {};

        if (message.type === "stream_event") {
            // Token deltas — text and extended thinking both arrive here (partial messages are enabled). Each
            // request's message_start also reports its usage, which is the current context-window fill.
            const event = message.event as {
                type: string;
                delta?: { type: string; text?: string; thinking?: string };
                message?: {
                    model?: string;
                    usage?: { input_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
                };
            };
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
                yield { kind: "delta", text: event.delta.text, ...withParent };
            } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && typeof event.delta.thinking === "string") {
                yield { kind: "thinking", text: event.delta.thinking, ...withParent };
            } else if (event.type === "message_start" && event.message?.usage !== undefined) {
                // Full input sent for this request = the context fill right now (input + both cache buckets).
                const usage = event.message.usage;
                contextTokens = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
                contextModel = event.message.model;
            }
        } else if (message.type === "assistant") {
            // Text/thinking already streamed as deltas above; here we only surface tool calls (and the
            // TodoWrite checklist, which is a tool call we render as its own live list).
            if (message.error !== undefined) {
                // rate_limit is Claude's subscription usage cap, not a workspace fault — tag it so the UI can
                // render it as a "wait and retry" notice instead of a red crash line (see conversation.ts).
                yield message.error === "rate_limit"
                    ? {
                          kind: "error",
                          code: "rate_limit",
                          message:
                              "Claude usage limit reached — this is the Claude subscription's rate limit resetting, not a workspace problem. Your last message wasn't processed; try again shortly.",
                      }
                    : { kind: "error", message: `agent error: ${message.error}` };
            } else {
                const content = message.message.content as ReadonlyArray<{ type: string; id?: string; name?: string; input?: unknown }>;
                for (const block of content) {
                    if (block.type !== "tool_use" || typeof block.name !== "string") {
                        continue;
                    }
                    if (block.name === "TodoWrite") {
                        const items = todoItems(block.input);
                        if (items !== undefined) {
                            yield { kind: "todos", items };
                            continue;
                        }
                    }
                    // First Bash of the turn: name the live `agent-<id>` tmux session so the browser surfaces
                    // that terminal. Same derivation the PreToolUse hook routes commands through, so they match.
                    // Remember every Bash tool_use id so the tool_result below can re-surface (the session may
                    // not exist yet at tool_use — the SDK can lag before actually running the command).
                    if (block.name === "Bash" && tmuxEnabled && typeof sessionId === "string") {
                        agentSession ??= agentSessionName(sessionId);
                        if (agentSession !== undefined) {
                            if (block.id !== undefined) {
                                bashToolIds.add(block.id);
                            }
                            if (!terminalSent) {
                                terminalSent = true;
                                yield { kind: "terminal", session: agentSession };
                            }
                        }
                    }
                    const target = toolTarget(block.input);
                    yield {
                        kind: "tool",
                        name: block.name,
                        ...(block.id !== undefined ? { id: block.id } : {}),
                        ...(target !== undefined ? { target } : {}),
                        ...withParent,
                    };
                }
            }
        } else if (message.type === "user") {
            // Tool results come back as tool_result blocks on a (usually synthetic) user message — this is
            // where edit diffs and bash output live.
            const content = message.message.content;
            if (Array.isArray(content)) {
                for (const block of content as ReadonlyArray<{ type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
                    if (block.type !== "tool_result") {
                        continue;
                    }
                    // Backstop: the first Bash tool_result guarantees tmux-run has created the session, so
                    // re-surface the terminal in case the tool_use-time relist raced ahead of session creation.
                    if (!terminalResurfaced && agentSession !== undefined && block.tool_use_id !== undefined && bashToolIds.has(block.tool_use_id)) {
                        terminalResurfaced = true;
                        yield { kind: "terminal", session: agentSession };
                    }
                    yield {
                        kind: "tool_result",
                        output: resultText(block.content),
                        ...(block.tool_use_id !== undefined ? { id: block.tool_use_id } : {}),
                        ...(block.is_error === true ? { isError: true } : {}),
                    };
                }
            }
        } else if (message.type === "system") {
            if (message.subtype === "init") {
                // Guard the model: the frame's schema requires a string, so never forward an empty init.
                if (message.model) {
                    yield { kind: "init", model: message.model };
                }
            } else if (message.subtype === "compact_boundary") {
                const meta = message.compact_metadata;
                yield {
                    kind: "compact",
                    trigger: meta.trigger,
                    preTokens: meta.pre_tokens,
                    ...(meta.post_tokens !== undefined ? { postTokens: meta.post_tokens } : {}),
                };
            }
        } else if (message.type === "rate_limit_event") {
            // Claude subscription usage for the turn: which window is active, how much of it is spent, and when
            // it resets. The SDK reports it on the stream at no token cost — we'd otherwise drop it below. Only
            // Claude turns emit it (Codex/Grok have no equivalent).
            const info = message.rate_limit_info;
            yield {
                kind: "rate_limit_info",
                status: info.status,
                ...(info.resetsAt !== undefined ? { resetsAt: info.resetsAt } : {}),
                ...(info.rateLimitType !== undefined ? { rateLimitType: info.rateLimitType } : {}),
                ...(info.utilization !== undefined ? { utilization: info.utilization } : {}),
            };
        } else if (message.type === "result") {
            // Only surface accounting when the SDK actually reported it (real turns always do; the empty
            // frame would be noise).
            if (message.usage !== undefined || message.total_cost_usd !== undefined) {
                yield {
                    kind: "usage",
                    ...(message.total_cost_usd !== undefined ? { costUsd: message.total_cost_usd } : {}),
                    ...(message.usage?.input_tokens !== undefined ? { inputTokens: message.usage.input_tokens } : {}),
                    ...(message.usage?.output_tokens !== undefined ? { outputTokens: message.usage.output_tokens } : {}),
                    ...(message.usage?.cache_read_input_tokens !== undefined ? { cacheReadTokens: message.usage.cache_read_input_tokens } : {}),
                    ...(message.usage?.cache_creation_input_tokens !== undefined
                        ? { cacheCreationTokens: message.usage.cache_creation_input_tokens }
                        : {}),
                    ...(message.duration_ms !== undefined ? { durationMs: message.duration_ms } : {}),
                    ...(message.num_turns !== undefined ? { numTurns: message.num_turns } : {}),
                };
            }
            // Context-window fill: pair the latest message_start input size with the model's window (a static
            // per-model constant carried on the result). Key by the turn's model, fall back to the sole entry.
            if (contextTokens !== undefined) {
                const window =
                    (contextModel !== undefined ? message.modelUsage[contextModel]?.contextWindow : undefined) ??
                    Object.values(message.modelUsage)[0]?.contextWindow;
                if (window !== undefined && window > 0) {
                    yield { kind: "context_usage", tokens: contextTokens, contextWindow: window };
                }
            }
            if (message.subtype !== "success") {
                yield { kind: "error", message: `agent did not complete (${message.subtype})` };
            }
            return;
        }
        // Any other SDK message type (hook / task / plugin / status / …) has no UI mapping — dropped, as
        // before. New high-value types earn a dedicated frame above; the rest stay silent rather than noisy.
    }
}

// Render the user's question picks (or a dismissal) as the `ask` tool's text result.
const formatAnswers = (questions: AskQuestion[], response: QuestionResponse): string => {
    if (response.cancelled || response.answers === undefined) {
        return "The user dismissed the questions without answering. Proceed with sensible defaults unless essential.";
    }
    const answers = response.answers;
    const lines = questions.map((q) => {
        const picks = answers[q.question] ?? [];
        return `- ${q.header || q.question}: ${picks.length > 0 ? picks.join(", ") : "(no answer)"}`;
    });
    return `The user answered:\n${lines.join("\n")}`;
};

// Cap the stderr tail folded into an error message so a chatty failure can't flood the UI.
const STDERR_TAIL = 2000;

// Fold the Claude Code subprocess's stderr tail into the surfaced error, so a bare "exited with code 1"
// becomes the actual reason. Without this the SDK's terminal error is opaque (this is how the
// root/`--dangerously-skip-permissions` failure was found).
const errorMessage = (error: unknown, stderr: string): string => {
    const base = error instanceof Error ? error.message : "agent failed";
    const detail = stderr.trim().slice(-STDERR_TAIL);
    return detail ? `${base}: ${detail}` : base;
};

// Base SDK options shared by both paths.
const baseOptions = (request: AgentRequest, abortController: AbortController, permissionMode: PermissionMode, tmuxEnabled: boolean): Options => ({
    cwd: request.cwd,
    includePartialMessages: true,
    permissionMode,
    abortController,
    // Inherit Claude Code's coding-tuned system prompt. The Agent SDK sends an EMPTY system prompt when this
    // is omitted, which is the main reason a bare SDK turn feels weaker at coding than the CLI/VSCode product.
    systemPrompt: { type: "preset", preset: "claude_code", ...(request.systemAppend !== undefined ? { append: request.systemAppend } : {}) },
    // Load the workspace's .claude/ config: CLAUDE.md memory, skills, subagents (.claude/agents), settings,
    // hooks, and .mcp.json — plus the user tier. The SDK default is [] (loads nothing), so every filesystem
    // capability was invisible until now. New skills/subagents/hooks then arrive as files, no code change.
    settingSources: ["user", "project"],
    env: {
        ...process.env,
        // cli-kind capability credentials (e.g. DISCORD_BOT_TOKEN) the agent's shell reads. Rebuilt every turn,
        // so a newly-added CLI capability is picked up on the next message with no restart.
        ...request.cliEnv,
        // We run with --dangerously-skip-permissions (bypassPermissions) because the container IS the
        // isolation boundary. Claude Code refuses that flag under root (the sandbox runs as root) unless
        // IS_SANDBOX marks the environment as already-sandboxed — which this container is.
        IS_SANDBOX: "1",
        ...(request.oauthToken !== undefined ? { CLAUDE_CODE_OAUTH_TOKEN: request.oauthToken } : {}),
    },
    // Run every Bash command inside an `agent-*` tmux session (bin/tmux-run) so the terminal panel can
    // watch the agent work live. Hooks fire even under bypassPermissions, and for subagents too.
    ...(tmuxEnabled ? { hooks: bashTmuxHooks() } : {}),
    ...(request.model !== undefined ? { model: request.model } : {}),
    ...(request.sessionId !== undefined ? { resume: request.sessionId } : {}),
    ...(request.plugins !== undefined ? { plugins: request.plugins.map((path) => ({ type: "local" as const, path })) } : {}),
    ...(request.effort !== undefined ? { effort: request.effort as EffortLevel } : {}),
    ...(request.thinking !== undefined ? { thinking: request.thinking ? { type: "adaptive" } : { type: "disabled" } } : {}),
    ...(request.disallowedTools !== undefined ? { disallowedTools: [...request.disallowedTools] } : {}),
});

// Run one agent turn over `request.cwd`, streaming typed events. A throwing/aborted turn surfaces as an
// `error` event (errors are reported to the UI, not swallowed, then the stream closes with `done`).
export async function* runAgent(request: AgentRequest, queryFn: QueryFn = defaultQuery): AsyncGenerator<AgentEvent> {
    const abortController = new AbortController();
    if (request.signal.aborted) {
        abortController.abort();
    } else {
        request.signal.addEventListener("abort", () => abortController.abort(), { once: true });
    }

    if (request.plan === true) {
        yield* runPlanTurn(request, queryFn, abortController);
        return;
    }

    // Default autonomous posture: full tools, no prompting. The container's isolation makes this safe.
    const permissionMode: PermissionMode = request.permissionMode ?? "bypassPermissions";
    const mcpServers = { ...request.sdkServers, ...mcpServersOf(request.tools ?? []) };
    const tmuxEnabled = tmuxRunEnabled();
    let stderr = "";
    const options: Options = {
        ...baseOptions(request, abortController, permissionMode, tmuxEnabled),
        allowDangerouslySkipPermissions: permissionMode === "bypassPermissions",
        stderr: (data) => {
            stderr += data;
        },
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    };
    try {
        yield* streamSdk(queryFn, request.prompt, options, tmuxEnabled);
    } catch (error) {
        yield { kind: "error", message: errorMessage(error, stderr) };
    }
    yield { kind: "done" };
}

// Always-plan flow: the model proposes via ExitPlanMode (we surface a `plan` event and block on the user's
// approval), asks clarifying questions via AskUserQuestion (aliased to our `ask` tool → `question` event),
// and once approved executes with every tool auto-accepted. `canUseTool` runs concurrently with the SDK
// loop, so a queue bridges both into this generator.
const noop = (): void => {};

async function* runPlanTurn(request: AgentRequest, queryFn: QueryFn, abortController: AbortController): AsyncGenerator<AgentEvent> {
    const queue: AgentEvent[] = [];
    let wake: () => void = noop;
    let finished = false;
    const push = (event: AgentEvent): void => {
        queue.push(event);
        wake();
    };

    const uiServer = createSdkMcpServer({
        name: "ui",
        tools: [
            tool(
                "ask",
                'Ask the user 1-4 clarifying multiple-choice questions and wait for their answers. Use this whenever you need the user to choose between options before proceeding. Each question has 2-4 options; do NOT add an "Other" option — a free-text choice is provided automatically. Set multiSelect when several options may be picked together.',
                {
                    questions: z
                        .array(
                            z.object({
                                question: z.string(),
                                header: z.string(),
                                multiSelect: z.boolean(),
                                options: z
                                    .array(z.object({ label: z.string(), description: z.string(), preview: z.string().optional() }))
                                    .min(2)
                                    .max(4),
                            }),
                        )
                        .min(1)
                        .max(4),
                },
                async (args) => {
                    const { id, wait } = createQuestionRequest();
                    push({ kind: "question", requestId: id, questions: args.questions as AskQuestion[] });
                    const response = await wait(request.signal);
                    return { content: [{ type: "text", text: formatAnswers(args.questions as AskQuestion[], response) }] };
                },
            ),
        ],
    });

    const tmuxEnabled = tmuxRunEnabled();
    let stderr = "";
    const options: Options = {
        ...baseOptions(request, abortController, "plan", tmuxEnabled),
        stderr: (data) => {
            stderr += data;
        },
        // The `ui` server backs AskUserQuestion; the agent's remote MCP tools are merged in alongside it so
        // the model can also consult them while planning (a same-named tool would override `ui`, but `ui` is
        // reserved). canUseTool auto-allows every tool after approval, so the remote tools need no extra gate.
        mcpServers: { ui: uiServer, ...request.sdkServers, ...mcpServersOf(request.tools ?? []) },
        toolAliases: { AskUserQuestion: "mcp__ui__ask" },
        planModeInstructions:
            "Propose a clear, concise approach for the user's request, then call ExitPlanMode to ask for approval before executing. When you need the user to choose between options, ask with the AskUserQuestion tool rather than writing the choices as plain text.",
        canUseTool: async (toolName, input) => {
            if (toolName === "ExitPlanMode") {
                const { id, wait } = createPlanRequest();
                push({ kind: "plan", decisionId: id, text: String((input as { plan?: unknown }).plan ?? "") });
                const decision = await wait(request.signal);
                if (decision.approve) {
                    return { behavior: "allow", updatedInput: input };
                }
                return { behavior: "deny", message: decision.feedback?.trim() || "Keep refining the plan — do not exit plan mode yet." };
            }
            // After approval (and for question prompts) every tool is auto-accepted — the container is the
            // isolation boundary, so execution needs no per-command prompting.
            return { behavior: "allow", updatedInput: input };
        },
    };

    const pump = (async () => {
        try {
            for await (const event of streamSdk(queryFn, request.prompt, options, tmuxEnabled)) {
                push(event);
            }
        } catch (error) {
            push({ kind: "error", message: errorMessage(error, stderr) });
        } finally {
            finished = true;
            wake();
        }
    })();

    try {
        for (;;) {
            if (queue.length > 0) {
                yield queue.shift() as AgentEvent;
                continue;
            }
            if (finished) {
                break;
            }
            await new Promise<void>((resolve) => {
                wake = resolve;
            });
            wake = noop;
        }
    } finally {
        await pump;
    }
    yield { kind: "done" };
}
