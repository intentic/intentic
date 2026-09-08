import type { InteractionUpdate, TodoItem as CursorTodo, ToolCall } from "@cursor/sdk";
import type { AgentEvent, TodoItem, ToolCallContent } from "@intentic/sandbox-contract";
import { diffContent, displayNameOf, toolCategoryOf, toolLocations, toolTarget, workspacePath } from "../../agent/tools/tool-calls.js";

// Pure mapping of Cursor's InteractionUpdate onto AgentEvent frames; drops updates with no UI meaning instead of
// passing them through. Reads only the delta stream (`send({ onDelta })`), the richer of two overlapping views of a
// run; `run.stream()` goes unused, and the run's own result supplies only success or failure.

// What a plan phase holds back instead of streaming: the assistant's text is the plan. errored suppresses it, since a
// plan must never come from partial, failed output.
export interface CursorTurnCapture {
    planText?: string;
    errored?: boolean;
}

export interface CursorEventMapper {
    // One update to its frames, usually 0 or 1; a completed tool call can carry both status and content.
    readonly map: (update: InteractionUpdate) => AgentEvent[];
    // The turn's usage frame, once; undefined when the run reported none.
    readonly usage: () => AgentEvent | undefined;
    // What the turn held back, read at settle: a plan phase's text, and whether an error frame went out.
    readonly capture: () => CursorTurnCapture;
}

// shell maps to "Bash"; updateTodos is absent, its checklist is a todos frame, never a card.
const CURSOR_TOOL_NAMES: Record<string, string> = {
    shell: "Bash",
    read: "Read",
    edit: "Edit",
    write: "Write",
    delete: "Delete",
    ls: "LS",
    glob: "Glob",
    grep: "Grep",
    semSearch: "Search",
    readLints: "Lints",
    createPlan: "Plan",
    generateImage: "Generate image",
    recordScreen: "Record screen",
    task: "Task",
};

// MCP calls are named for the tool they called, not "mcp", which would collapse every connected account's actions into
// one row. Spelled server__tool so the shared taxonomy's trailing-verb categorisation works unchanged.
const nameOf = (call: ToolCall): string => {
    if (call.type === "mcp") {
        const args = call.args as { providerIdentifier?: unknown; toolName?: unknown };
        const tool = typeof args.toolName === "string" ? args.toolName : "call";
        const provider = typeof args.providerIdentifier === "string" ? args.providerIdentifier : "mcp";
        return displayNameOf(`mcp__${provider}__${tool}`);
    }
    return CURSOR_TOOL_NAMES[call.type] ?? displayNameOf(call.type);
};

// Cursor's own argument spellings: the shared toolTarget gets file tools right by luck (path) but misses glob's
// targetDirectory. Kept here rather than widening the shared helper, which shouldn't accumulate every vendor's names.
const targetOf = (call: ToolCall, cwd: string): string | undefined => {
    const args = call.args as Record<string, unknown>;
    const raw = args["path"] ?? args["targetDirectory"] ?? args["filePath"];
    if (typeof raw === "string" && raw !== "") {
        return workspacePath(raw, cwd) ?? raw;
    }
    return toolTarget(call.args);
};

// Content known before any result exists: a write's whole new file is a diff, drawable immediately. An edit's args
// carry only the path; its diff arrives on the result (completedContent).
const startedContent = (call: ToolCall, cwd: string): ToolCallContent[] | undefined => {
    if (call.type !== "write") {
        return undefined;
    }
    const args = call.args as { path?: unknown; fileText?: unknown };
    if (typeof args.path !== "string" || typeof args.fileText !== "string") {
        return undefined;
    }
    return [diffContent(workspacePath(args.path, cwd) ?? args.path, undefined, args.fileText)];
};

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

// What a finished call shows, most specific first:
// - edit: the vendor's own unified diff
// - shell: stdout and stderr, joined like a terminal
// - everything else: summarized text, using the vendor's own failure message, not a generic one
const completedContent = (call: ToolCall): ToolCallContent[] | undefined => {
    const result = call.result as Record<string, unknown> | undefined;
    if (result === undefined) {
        return undefined;
    }
    if (result["status"] === "error") {
        const message = text(result["message"]) ?? "The tool call failed.";
        return [{ type: "text", text: message }];
    }
    // Arrives pre-rendered as a unified diff, sent as text; reconstructing before/after risks a mismatch with disk.
    if (call.type === "edit") {
        const diff = text(result["diffString"]);
        return diff === undefined ? undefined : [{ type: "text", text: diff }];
    }
    if (call.type === "shell") {
        const streams = [text(result["stdout"]), text(result["stderr"])].filter((part): part is string => part !== undefined);
        return streams.length === 0 ? undefined : [{ type: "text", text: streams.join("\n") }];
    }
    if (call.type === "read") {
        const content = text(result["content"]);
        return content === undefined ? undefined : [{ type: "text", text: content }];
    }
    if (call.type === "grep" || call.type === "glob" || call.type === "ls" || call.type === "semSearch") {
        const output = text(result["output"]);
        return output === undefined ? undefined : [{ type: "text", text: output }];
    }
    return undefined;
};

// cancelled maps to completed, not pending: the alternative leaves a checklist item that can never finish.
const TODO_STATUS: Record<string, TodoItem["status"]> = {
    pending: "pending",
    inProgress: "in_progress",
    completed: "completed",
    cancelled: "completed",
};

const toTodos = (todos: readonly CursorTodo[]): TodoItem[] =>
    todos.map((todo) => ({ content: todo.content, status: TODO_STATUS[todo.status] ?? "pending" }));

export const createCursorEventMapper = (cwd: string, holdText = false): CursorEventMapper => {
    // Shell call in flight: output updates don't name their call; only one runs at a time, so 'last started' is it.
    let liveShell: { id: string; output: string } | undefined;
    const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    let sawUsage = false;
    const capture: CursorTurnCapture = {};

    const map = (update: InteractionUpdate): AgentEvent[] => {
        switch (update.type) {
            case "text-delta": {
                if (update.text === "") {
                    return [];
                }
                if (holdText) {
                    capture.planText = (capture.planText ?? "") + update.text;
                    return [];
                }
                return [{ kind: "delta", text: update.text }];
            }
            case "thinking-delta":
                return update.text === "" ? [] : [{ kind: "thinking", text: update.text }];
            case "tool-call-started": {
                const call = update.toolCall;
                // Checklist is its own frame, never a card: the panel draws it; emitted on start, args carry the list.
                if (call.type === "updateTodos") {
                    const args = call.args as { todos?: readonly CursorTodo[] };
                    return args.todos === undefined ? [] : [{ kind: "todos", items: toTodos(args.todos) }];
                }
                const name = nameOf(call);
                if (call.type === "shell") {
                    liveShell = { id: update.callId, output: "" };
                }
                const target = targetOf(call, cwd);
                const locations = toolLocations(call.args, cwd);
                const content = startedContent(call, cwd);
                return [
                    {
                        kind: "tool_call",
                        id: update.callId,
                        name,
                        category: toolCategoryOf(name),
                        status: "in_progress",
                        ...(target !== undefined ? { target } : {}),
                        ...(locations !== undefined ? { locations } : {}),
                        ...(content !== undefined ? { content } : {}),
                    },
                ];
            }
            case "tool-call-completed": {
                const call = update.toolCall;
                if (call.type === "updateTodos") {
                    const result = call.result as { todos?: readonly CursorTodo[] } | undefined;
                    return result?.todos === undefined ? [] : [{ kind: "todos", items: toTodos(result.todos) }];
                }
                if (liveShell?.id === update.callId) {
                    liveShell = undefined;
                }
                const failed = (call.result as { status?: unknown } | undefined)?.status === "error";
                const content = completedContent(call);
                return [
                    {
                        kind: "tool_call_update",
                        id: update.callId,
                        status: failed ? "failed" : "completed",
                        ...(content !== undefined ? { content } : {}),
                    },
                ];
            }
            // Untyped passthrough: the SDK's `event` is a bare record, so field names aren't part of the contract.
            // Tries a few plausible spellings and drops the rest; the card catches up when the call completes.
            case "shell-output-delta": {
                if (liveShell === undefined) {
                    return [];
                }
                const event = update.event as Record<string, unknown>;
                const chunk = text(event["output"]) ?? text(event["chunk"]) ?? text(event["data"]) ?? text(event["text"]);
                if (chunk === undefined) {
                    return [];
                }
                // Snapshot semantics: content replaces each update, so the accumulated output is sent, not the delta.
                liveShell.output += chunk;
                return [{ kind: "tool_call_update", id: liveShell.id, content: [{ type: "text", text: liveShell.output }] }];
            }
            // Set by the reading, not the event: no usage means no frame, not zeros, since zero tokens is a claim and
            // "not told" is true. Summed, not assigned: one send can end several turns (a plan phase and its
            // execution).
            case "turn-ended": {
                if (update.usage === undefined) {
                    return [];
                }
                sawUsage = true;
                totals.inputTokens += update.usage.inputTokens;
                totals.outputTokens += update.usage.outputTokens;
                totals.cacheReadTokens += update.usage.cacheReadTokens;
                totals.cacheCreationTokens += update.usage.cacheWriteTokens;
                return [];
            }
            // Silently dropped, each already covered elsewhere:
            // partial-tool-call / tool-call-delta: argument streaming, rendered from the started frame
            // token-delta: a running count; usage reports properly at the end
            // step-* / summary*: the loop's own bookkeeping
            // user-message-appended: this turn's own prompt echoed back
            default:
                return [];
        }
    };

    return {
        map,
        usage: () =>
            sawUsage
                ? {
                      kind: "usage",
                      inputTokens: totals.inputTokens,
                      outputTokens: totals.outputTokens,
                      cacheReadTokens: totals.cacheReadTokens,
                      cacheCreationTokens: totals.cacheCreationTokens,
                  }
                : undefined,
        capture: () => capture,
    };
};
