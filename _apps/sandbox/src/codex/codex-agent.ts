import {
    Codex,
    type CodexOptions,
    type Input,
    type ModelReasoningEffort,
    type SandboxMode,
    type ThreadEvent,
    type ThreadItem,
    type ThreadOptions,
} from "@openai/codex-sdk";
import type { AgentEvent, ToolCallLocation } from "@intentic/sandbox-contract";
import type { AgentRequest } from "../agent/agent.js";
import { splitAttachments, withFileNote } from "../agent/attachment-note.js";
import { EXECUTE_PROMPT, type ExecutePhase, type PlanPhase, runPlanEmulation } from "../agent/plan-emulation.js";
import { toolCategoryOf, workspacePath } from "../agent/tool-calls.js";
import { CODEX_ADVISORY, CODEX_MODEL_INVALID } from "./codex-models.js";

/* The Codex provider adapter: same seam as agent.ts's runAgent — AgentRequest in, AgentEvent frames out — but
 * backed by the Codex CLI (`codex exec` via @openai/codex-sdk) instead of the Claude Agent SDK. Provider
 * differences stay inside this file; the wire contract, routes, and UI are shared.
 *
 * The exec surface emits item-level events only (whole agent messages, no token deltas) and has no interactive
 * approval channel — both fine here: the UI typewriter smooths chunky deltas, and the container is the
 * isolation boundary (the Claude path already runs bypassPermissions for the same reason).
 * ponytail: `codex app-server` is the upgrade path for token deltas + per-command approvals, swappable inside
 * this file alone. */

// One Codex turn: resume the thread when sessionId is present, else start a new one. Injected so tests drive a
// fake ThreadEvent stream — no CLI spawn (the QueryFn pattern from agent.ts).
export interface CodexTurn {
    readonly prompt: string;
    // Absolute image paths riding as native local_image inputs (Codex vision reads them by path).
    readonly images?: readonly string[];
    readonly sessionId?: string;
    readonly env: Record<string, string>;
    // `--config` overrides for the CLI (the SDK flattens them to dotted TOML paths) — carries the translator
    // provider block on a subscription-served turn; absent ⇒ Codex's own defaults (ChatGPT OAuth / API key).
    readonly config?: NonNullable<CodexOptions["config"]>;
    readonly options: ThreadOptions;
    readonly signal: AbortSignal;
}
export type CodexRunner = (turn: CodexTurn) => AsyncIterable<ThreadEvent>;

// The SDK does NOT inherit process.env when `env` is passed, so the runner receives the full environment.
const defaultRunner: CodexRunner = async function* (turn) {
    const codex = new Codex({ env: turn.env, ...(turn.config !== undefined ? { config: turn.config } : {}) });
    const thread = turn.sessionId !== undefined ? codex.resumeThread(turn.sessionId, turn.options) : codex.startThread(turn.options);
    const input: Input =
        turn.images !== undefined && turn.images.length > 0
            ? [{ type: "text", text: turn.prompt }, ...turn.images.map((path) => ({ type: "local_image" as const, path }))]
            : turn.prompt;
    const { events } = await thread.runStreamed(input, { signal: turn.signal });
    yield* events;
};

// Codex's reasoning-effort scale matches the SDK's EffortLevel except the top: Claude's "max" → Codex "xhigh".
const EFFORT_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const reasoningEffort = (effort: string): ModelReasoningEffort | undefined => {
    if (effort === "max") {
        return "xhigh";
    }
    return EFFORT_LEVELS.has(effort) ? (effort as ModelReasoningEffort) : undefined;
};

// process.env with undefined entries dropped (CodexOptions.env is Record<string, string>), cli-kind capability
// credentials merged, and CODEX_HOME pinned to the workspace-scoped auth/session store.
//
// CODEX_API_KEY is NOT inherited: it is the translator bearer, and the only turn entitled to one is the turn that
// resolved a codexEndpoint (which sets it explicitly below). A daemon whose own environment carries a bearer —
// exactly what a sandbox running the translator looks like — would otherwise hand it to native account turns too.
const codexEnv = (codexHome: string, cliEnv: Record<string, string> | undefined): Record<string, string> => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key !== "CODEX_API_KEY") {
            env[key] = value;
        }
    }
    return { ...env, ...cliEnv, CODEX_HOME: codexHome };
};

// The subscription-served provider block: Codex speaks its own Responses wire format to the translator
// (CLIProxyAPI), which serves it on the connected ChatGPT subscription; auth is the fixed local bearer via
// env_key (never a rotating OAuth token, so nothing races the translator's own refresh loop).
// supports_websockets=false is load-bearing: the translator's inbound is plain POST SSE, and without it Codex
// burns five WebSocket connect retries per turn before falling back.
const translatorProvider = (baseUrl: string): NonNullable<CodexOptions["config"]> => ({
    model_provider: "translator",
    model_providers: {
        translator: {
            name: "translator",
            base_url: `${baseUrl.replace(/\/$/, "")}/v1`,
            wire_api: "responses",
            env_key: "CODEX_API_KEY",
            supports_websockets: false,
        },
    },
});

const threadOptions = (request: AgentRequest, sandboxMode: SandboxMode): ThreadOptions => {
    const effort = request.effort !== undefined ? reasoningEffort(request.effort) : undefined;
    return {
        workingDirectory: request.cwd,
        // The workspace root holds the repos but is not itself a git repo.
        skipGitRepoCheck: true,
        sandboxMode,
        // No approval channel on the exec surface; the container is the isolation boundary (same posture as
        // the Claude path's bypassPermissions).
        approvalPolicy: "never",
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(effort !== undefined ? { modelReasoningEffort: effort } : {}),
    };
};

// Flatten an MCP result's content blocks to plain text, like agent.ts's resultText.
const mcpResultText = (item: Extract<ThreadItem, { type: "mcp_tool_call" }>): string => {
    if (item.error !== undefined) {
        return item.error.message;
    }
    const content = item.result?.content;
    if (!Array.isArray(content)) {
        return "";
    }
    return content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("");
};

/* Codex's IN-TURN stream retry, which arrives on the same error channels a real failure does. The CLI lost the
 * response stream mid-turn, is reconnecting, and the turn carries on from where it was — the message is
 * `Reconnecting... <attempt>/<max> (<reason>)`, minted by codex's own retry loop (core/src/responses_retry.rs)
 * and forwarded with `will_retry: true`, which its JSONL surface then drops.
 *
 * Read as a failure it painted a red error line under a turn that answered normally four minutes later, wrote a
 * turn.error into the activity log, reddened the agent's card on the fleet board, and — in plan mode — would
 * have dropped the plan (plan-emulation abandons an errored phase). It is still worth SAYING, because a turn
 * riding out a dropped socket goes quiet and silence reads as a hang: it says it as the wait it is, on the
 * `provider_retry` frame the Claude path emits for exactly this (agent.ts, api_retry), which takes over the
 * chat's loader line and retires itself on the next frame.
 *
 * No `nextAttemptAt`: codex reports the counters but not its backoff, and the contract makes the instant
 * optional rather than have this guess one. */
const CODEX_STREAM_RETRY = /^Reconnecting\.\.\.\s*(\d+)\s*\/\s*(\d+)/;

/* What a codex error message actually is, when it is not a failure. Both of codex's error channels run through
 * here so a notice reads the same whichever one carries it — the CLI has moved them before (an advisory rides
 * the item channel, a stream retry the top-level event) and the two are one `error` kind by the time they reach
 * us. Undefined ⇒ a real failure, which is every other message. */
const codexNotice = (message: string): AgentEvent | undefined => {
    const retry = CODEX_STREAM_RETRY.exec(message);
    if (retry !== null) {
        return { kind: "provider_retry", attempt: Number(retry[1]), maxAttempts: Number(retry[2]) };
    }
    // An advisory shares this channel with real failures but is not one — the turn answers normally after it. So
    // it must not mark the phase errored: a plan turn that hit one still has a plan to propose (CODEX_ADVISORY).
    return CODEX_ADVISORY.test(message) ? { kind: "error", code: "codex-advisory", message } : undefined;
};

// What phase-1 of a plan turn holds back: the thread id (to resume for execution) and the trailing
// agent_message (the plan text the user approves).
interface TurnCapture {
    threadId?: string;
    heldMessage?: string;
    // Set when the plan phase hit a terminal error (turn.failed / error / item error), so runCodexPlanTurn
    // suppresses the plan frame — a failed turn must not surface a "plan" even if a message was held first.
    errored?: boolean;
}

// Normalize one Codex turn's ThreadEvent stream onto AgentEvents. `capture` set ⇒ plan phase: agent messages
// are held back one-deep — intermediate narration still streams (flushed when the next message arrives), and
// whatever remains held at stream end is the plan text.
async function* streamTurn(events: AsyncIterable<ThreadEvent>, cwd: string, capture?: TurnCapture): AsyncGenerator<AgentEvent> {
    for await (const event of events) {
        if (event.type === "thread.started") {
            if (capture !== undefined) {
                capture.threadId = event.thread_id;
            }
            yield { kind: "session", sessionId: event.thread_id };
        } else if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
            const item = event.item;
            if (item.type === "agent_message") {
                if (event.type !== "item.completed") {
                    continue;
                }
                // Only `item.completed` reaches here, so each delta below is a WHOLE message block — its
                // text_end follows immediately, which retires the client's prose bubble so the tool calls this
                // message introduced render under it instead of being hoisted above the turn's whole narration.
                if (capture === undefined) {
                    yield { kind: "delta", text: item.text };
                    yield { kind: "text_end" };
                } else {
                    if (capture.heldMessage !== undefined) {
                        yield { kind: "delta", text: capture.heldMessage };
                        yield { kind: "text_end" };
                    }
                    capture.heldMessage = item.text;
                }
            } else if (item.type === "reasoning") {
                if (event.type === "item.completed") {
                    yield { kind: "thinking", text: item.text };
                }
            } else if (item.type === "command_execution") {
                if (event.type === "item.started") {
                    yield { kind: "tool_call", id: item.id, name: "Bash", category: "execute", status: "in_progress", target: item.command };
                } else if (event.type === "item.updated") {
                    // Live output: item.updated carries the aggregated output SO FAR as a snapshot — exactly the
                    // update frame's replace semantics, so a long command streams into its card.
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
                // Emitted once, on success or failure; the item carries paths but no diff text (the app-server
                // surface is the upgrade path for a real diff), so the card shows locations + status only.
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
            } else if (item.type === "error") {
                if (event.type === "item.completed") {
                    const notice = codexNotice(item.message);
                    if (notice !== undefined) {
                        yield notice;
                        continue;
                    }
                    yield { kind: "error", message: item.message };
                    if (capture !== undefined) {
                        capture.errored = true;
                    }
                }
            }
        } else if (event.type === "turn.completed") {
            // Codex reports only a cached-input bucket (no separate cache-write), so map it to cacheReadTokens.
            yield {
                kind: "usage",
                inputTokens: event.usage.input_tokens,
                outputTokens: event.usage.output_tokens,
                cacheReadTokens: event.usage.cached_input_tokens,
            };
        } else if (event.type === "turn.failed") {
            yield { kind: "error", message: event.error.message };
            if (capture !== undefined) {
                capture.errored = true;
            }
        } else if (event.type === "error") {
            const notice = codexNotice(event.message);
            if (notice !== undefined) {
                yield notice;
                continue;
            }
            yield { kind: "error", message: event.message };
            if (capture !== undefined) {
                capture.errored = true;
            }
        }
        // turn.started has no UI mapping — dropped, like the Claude path's unmapped SDK messages.
    }
}

// Codex's preamble adds the read-only truth of its planning phase to the shared skeleton's wording.
const CODEX_PLAN_PREAMBLE =
    "Before making any changes, propose a clear, concise plan for the request below and stop — do not execute it yet. " +
    "You are in a read-only sandbox for this turn; end your reply with the plan itself.\n\n";

// Always-plan flow over the shared skeleton (the exec surface has no ExitPlanMode hook): a read-only planning
// turn whose trailing message becomes the plan, then a full-access execution turn resumed on the same thread.
// ponytail: no `question` frames on Codex (no AskUserQuestion analog in exec mode); app-server adds one.
async function* runCodexPlanTurn(
    request: AgentRequest,
    runner: CodexRunner,
    turnBase: Pick<CodexTurn, "env" | "config">,
): AsyncGenerator<AgentEvent> {
    const { images: firstTurnImages, others } = splitAttachments(request.attachments);
    // Images ride the first planning turn only — revision and execute turns resume the same thread, whose
    // context already holds them.
    let images = firstTurnImages;
    const planPhase: PlanPhase = async function* (prompt, sessionId) {
        const capture: TurnCapture = {};
        yield* streamTurn(
            runner({
                prompt,
                ...(images.length > 0 ? { images } : {}),
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...turnBase,
                options: threadOptions(request, "read-only"),
                signal: request.signal,
            }),
            request.cwd,
            capture,
        );
        images = [];
        return { sessionId: capture.threadId, planText: capture.heldMessage, errored: capture.errored === true };
    };
    const executePhase: ExecutePhase = (sessionId) =>
        streamTurn(
            runner({
                prompt: EXECUTE_PROMPT,
                ...(sessionId !== undefined ? { sessionId } : {}),
                ...turnBase,
                options: threadOptions(request, "danger-full-access"),
                signal: request.signal,
            }),
            request.cwd,
        );
    yield* runPlanEmulation(request.signal, CODEX_PLAN_PREAMBLE + withFileNote(request.prompt, others), request.sessionId, planPhase, executePhase);
}

// Build the Codex provider for the Services seam: AgentRequest in, AgentEvent frames out. Ignores the
// Claude-only request fields (oauthToken, permissionMode, plugins, thinking — Codex reasoning is always on).
// ponytail: request.tools (platform MCP servers) skipped on Codex turns; the ceiling is the SDK constructor's
// `config: { mcp_servers }` overrides.
export const createCodexAgent = (codexHome: string, runner: CodexRunner = defaultRunner) =>
    async function* runCodexAgent(request: AgentRequest): AsyncGenerator<AgentEvent> {
        // Per-account CODEX_HOME when the turn resolved one; the constructor's base dir is the OPENAI_API_KEY
        // fallback path only. A subscription-served turn (codexEndpoint) layers the translator provider block
        // on top: the bearer rides CODEX_API_KEY and the home holds only sessions — whatever auth.json it may
        // carry is ignored by the custom provider.
        const env = codexEnv(request.codexHome ?? codexHome, request.cliEnv);
        const turnBase: Pick<CodexTurn, "env" | "config"> =
            request.codexEndpoint !== undefined
                ? { env: { ...env, CODEX_API_KEY: request.codexEndpoint.authToken }, config: translatorProvider(request.codexEndpoint.baseUrl) }
                : { env };
        // Codex reports a real failure (out of credits, usage limits, a bad model) as a turn.failed/error frame
        // on its JSON stream and THEN exits non-zero — which makes the SDK throw a generic "Codex Exec exited
        // with code N: <stderr>" whose stderr is only codex's benign "Reading prompt from stdin..." line.
        // Surfacing that wrapper last would clobber the actionable message, so only emit it when nothing
        // specific was already streamed.
        const { images, others } = splitAttachments(request.attachments);
        const turn =
            request.permissionMode === "plan"
                ? runCodexPlanTurn(request, runner, turnBase)
                : streamTurn(
                      runner({
                          prompt: withFileNote(request.prompt, others),
                          ...(images.length > 0 ? { images } : {}),
                          ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
                          ...turnBase,
                          options: threadOptions(request, "danger-full-access"),
                          signal: request.signal,
                      }),
                      request.cwd,
                  );
        let surfacedError = false;
        try {
            for await (const event of turn) {
                if (event.kind === "error") {
                    // An advisory is already tagged and is not a failure, so it must not count as the turn's
                    // surfaced error — letting it stand in for one would swallow the SDK's exit-code wrapper on a
                    // turn that then died for a real reason.
                    if (event.code === "codex-advisory") {
                        yield event;
                        continue;
                    }
                    surfacedError = true;
                    // Tag a rejected/unusable model so the client reloads the live catalog and drops the bad pinned
                    // model, mirroring Grok's grok-model-invalid (OpenAI names no alternatives, so there's nothing
                    // to re-prompt with here — the reloaded default serves the next turn).
                    yield CODEX_MODEL_INVALID.test(event.message) ? { ...event, code: "codex-model-invalid" as const } : event;
                    continue;
                }
                yield event;
            }
        } catch (error) {
            if (!surfacedError) {
                const message = error instanceof Error ? error.message : "codex agent failed";
                yield { kind: "error", message, ...(CODEX_MODEL_INVALID.test(message) ? { code: "codex-model-invalid" as const } : {}) };
            }
        }
        yield { kind: "done" };
    };
