import type { InteractionUpdate, NestedTaskUpdate, TodoItem as CursorTodo, ToolCall } from "@cursor/sdk";
import type { AgentEvent, TodoItem, ToolCallContent } from "@intentic/sandbox-contract";
import { z } from "zod";
import { displayNameOf, toolTarget } from "@intentic/agent-context/tool-calls";
import { diffContent, toolInput, toolLocations, workspacePath } from "../../agent/tools/tool-calls.js";
import { toolCallOpened, type TurnCapture, usageTotals, type VendorEventMapper } from "../decorators/vendor-events.js";
import { opt } from "../../opt.js";
import { unshieldedCommand } from "./cursor-hook-script.js";

// Pure mapping of Cursor's InteractionUpdate onto AgentEvent frames; drops updates with no UI meaning instead of
// passing them through. Reads only the delta stream (`send({ onDelta })`), the richer of two overlapping views of a
// run; `run.stream()` goes unused, and the run's own result supplies only success or failure.

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

// An MCP call's own arguments, which Cursor nests one level down beside the server and tool names.
const mcpArgsOf = (call: ToolCall): unknown => (call.type === "mcp" ? (call.args as { args?: unknown } | undefined)?.args : undefined);

// Cursor's own argument spellings: the shared toolTarget gets file tools right by luck (path) but misses glob's
// targetDirectory. Kept here rather than widening the shared helper, which shouldn't accumulate every vendor's names.
const targetOf = (call: ToolCall, cwd: string): string | undefined => {
    if (call.type === "mcp") {
        return toolTarget(mcpArgsOf(call));
    }
    const args = call.args as Record<string, unknown>;
    // A command the privacy shield wrapped is shown as the command the model asked for (cursor-hook-script.ts).
    if (call.type === "shell" && typeof args["command"] === "string") {
        return toolTarget({ ...args, command: unshieldedCommand(args["command"]) });
    }
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
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const lines = (parts: readonly (string | undefined)[]): string | undefined => {
    const kept = parts.filter((part): part is string => part !== undefined && part !== "");
    return kept.length === 0 ? undefined : kept.join("\n");
};

// A finished call's result as the SDK hands it (its tool-call-types): `{ status: "success", value }` or
// `{ status: "error", error: { message } }`, read tolerantly since the shapes are the vendor's.
interface CallResult {
    readonly failed: boolean;
    readonly value: Record<string, unknown>;
    readonly message: string | undefined;
}
const resultOf = (call: ToolCall): CallResult | undefined => {
    const result = call.result as unknown;
    if (!isRecord(result)) {
        return undefined;
    }
    const error = isRecord(result["error"]) ? result["error"] : {};
    return { failed: result["status"] === "error", value: isRecord(result["value"]) ? result["value"] : {}, message: text(error["message"]) };
};

// Grep's matches, one line each the way ripgrep prints them, per workspace root and for the active editor alike.
const grepText = (value: Record<string, unknown>): string | undefined => {
    const found = (entry: unknown): (string | undefined)[] => {
        if (!isRecord(entry) || !isRecord(entry["output"])) {
            return [];
        }
        const output = entry["output"];
        const each = (key: string): Record<string, unknown>[] => (Array.isArray(output[key]) ? output[key].filter(isRecord) : []);
        switch (entry["type"]) {
            case "content":
                return each("matches").map((match) => {
                    const at = typeof match["lineNumber"] === "number" ? `:${String(match["lineNumber"])}` : "";
                    return `${text(match["file"]) ?? ""}${at}:${typeof match["line"] === "string" ? match["line"] : ""}`;
                });
            case "files":
                return Array.isArray(output["files"]) ? output["files"].map(text) : [];
            case "count":
                return each("counts").map((count) => `${text(count["file"]) ?? ""}:${String(count["count"] ?? 0)}`);
            default:
                return [];
        }
    };
    const roots = isRecord(value["workspaceResults"]) ? Object.values(value["workspaceResults"]) : [];
    return lines([...roots, value["activeEditorResult"]].flatMap(found));
};

// An ls tree as the paths it holds, directories with a trailing slash, the way a listing reads.
const lsText = (node: unknown): string | undefined => {
    const walk = (dir: unknown): string[] => {
        if (!isRecord(dir) || typeof dir["absPath"] !== "string") {
            return [];
        }
        const path = dir["absPath"];
        const files = Array.isArray(dir["childrenFiles"]) ? dir["childrenFiles"].filter(isRecord).map((file) => `${path}/${String(file["name"])}`) : [];
        const dirs = Array.isArray(dir["childrenDirs"]) ? dir["childrenDirs"].flatMap(walk) : [];
        return [`${path}/`, ...files, ...dirs];
    };
    return lines(walk(node));
};

// What a finished call shows, most specific first:
// - a failure: the vendor's own message, not a generic one
// - edit: the vendor's own unified diff
// - shell: stdout and stderr, joined like a terminal
// - read, search, listing and MCP calls: what they returned, as text
const completedText = (call: ToolCall, result: CallResult): string | undefined => {
    if (result.failed) {
        return result.message ?? "The tool call failed.";
    }
    const value = result.value;
    switch (call.type) {
        // Arrives pre-rendered as a unified diff, sent as text; reconstructing before/after risks a mismatch with disk.
        case "edit":
            return text(value["diffString"]);
        case "shell":
            return lines([text(value["stdout"]), text(value["stderr"])]);
        case "read":
            return text(value["content"]);
        case "grep":
            return grepText(value);
        case "glob":
            return Array.isArray(value["files"]) ? lines(value["files"].map(text)) : undefined;
        case "ls":
            return lsText(value["directoryTreeRoot"]);
        case "semSearch":
            return text(value["results"]);
        case "mcp":
            return Array.isArray(value["content"])
                ? lines(value["content"].filter(isRecord).map((part) => (isRecord(part["text"]) ? text(part["text"]["text"]) : undefined)))
                : undefined;
        default:
            return undefined;
    }
};

// A call's card as it opens; `parent` is the task call whose subagent made it. A call with no one-line target keeps its
// input (an MCP call's own arguments, a task's prompt).
const openedCard = (callId: string, call: ToolCall, cwd: string, parent?: string): AgentEvent => {
    const target = targetOf(call, cwd);
    return toolCallOpened({
        id: callId,
        name: nameOf(call),
        target,
        locations: toolLocations(call.args, cwd),
        content: startedContent(call, cwd),
        input: toolInput(call.type === "mcp" ? mcpArgsOf(call) : call.args, target),
        parentToolUseId: parent,
    });
};

// A finished call's card: failed on the vendor's own error status, with what it produced and, for a command, how it
// exited.
const closedCard = (callId: string, call: ToolCall): AgentEvent => {
    const result = resultOf(call);
    const said = result === undefined ? undefined : completedText(call, result);
    const exitCode = call.type === "shell" && result !== undefined && Number.isInteger(result.value["exitCode"]) ? (result.value["exitCode"] as number) : undefined;
    return {
        kind: "tool_call_update",
        id: callId,
        status: result?.failed === true ? "failed" : "completed",
        ...opt("content", said === undefined ? undefined : [{ type: "text" as const, text: said }]),
        ...opt("exitCode", exitCode),
    };
};

// Which calls have a card, so each is drawn once and closed once: a completion that overtakes its own start draws the
// call already finished (the completed call carries its arguments too), and the start arriving after it is dropped.
interface CardLedger {
    readonly opened: (callId: string, call: ToolCall, parent?: string) => AgentEvent[];
    readonly closed: (callId: string, call: ToolCall, parent?: string) => AgentEvent[];
    readonly isOpen: (callId: string) => boolean;
}
const cardLedger = (cwd: string): CardLedger => {
    const open = new Set<string>();
    const done = new Set<string>();
    return {
        opened: (callId, call, parent) => {
            if (open.has(callId) || done.has(callId)) {
                return [];
            }
            open.add(callId);
            return [openedCard(callId, call, cwd, parent)];
        },
        closed: (callId, call, parent) => {
            if (done.has(callId)) {
                return [];
            }
            const opening = open.delete(callId) ? [] : [openedCard(callId, call, cwd, parent)];
            done.add(callId);
            return [...opening, closedCard(callId, call)];
        },
        isOpen: (callId) => open.has(callId),
    };
};

// Cursor's own subagents (its `task` tool): the call's card carries the subagent it starts; the subagent's own steps,
// streamed as updates nested on that call (`tool-call-delta`, one level deep), nest under the card; the call's result
// ends it. Read tolerantly: the task's args and result in another shape leave the subagent less described, never fail
// the turn.
const TaskArgsSchema = z
    .object({
        description: z.string().optional().catch(undefined),
        model: z.string().optional().catch(undefined),
        subagentType: z.object({ kind: z.string().optional().catch(undefined), name: z.string().optional().catch(undefined) }).optional().catch(undefined),
    })
    .catch({});
const TaskResultSchema = z
    .object({
        status: z.string().optional().catch(undefined),
        value: z.object({ isBackground: z.boolean().catch(false), conversationSteps: z.array(z.unknown()).optional().catch(undefined) }).optional().catch(undefined),
        error: z.object({ message: z.string() }).optional().catch(undefined),
    })
    .catch({});
// A step of the subagent's own conversation, as the result lists them; its prose steps are what it said.
const SaidStepSchema = z.object({ assistantMessage: z.object({ text: z.string() }) });

// What the subagent said last, from the steps its result carries.
const lastSaid = (steps: readonly unknown[] | undefined): string | undefined =>
    (steps ?? []).flatMap((step) => {
        const said = SaidStepSchema.safeParse(step);
        return said.success && said.data.assistantMessage.text.trim() !== "" ? [said.data.assistantMessage.text.trim()] : [];
    }).at(-1);

export interface CursorSubagents {
    readonly started: (callId: string, call: ToolCall) => AgentEvent[];
    readonly nested: (callId: string, update: NestedTaskUpdate) => AgentEvent[];
    readonly completed: (callId: string, call: ToolCall) => AgentEvent[];
    // The run's end. A background subagent's own end reaches only its parent's model, but the run holds until every
    // one has ended, so a run that settled on its own saw each through.
    readonly settled: () => AgentEvent[];
}

export const cursorSubagents = (cards: CardLedger): CursorSubagents => {
    // Each subagent this run's task calls started and has not seen end, with its calls so far and whether it went on in
    // the background.
    const open = new Map<string, { calls: number; background: boolean }>();

    const nestedCall = (callId: string, update: Extract<NestedTaskUpdate, { type: "tool-call-started" | "tool-call-completed" }>): AgentEvent[] => {
        const task = open.get(callId);
        // A subagent's own checklist is its business, not the turn's.
        if (task === undefined || update.toolCall.type === "updateTodos") {
            return [];
        }
        // A call first heard of by its completion is still one of the subagent's calls.
        const counted = update.type === "tool-call-started" || !cards.isOpen(update.callId);
        const frames = update.type === "tool-call-completed" ? cards.closed(update.callId, update.toolCall, callId) : cards.opened(update.callId, update.toolCall, callId);
        if (!counted || frames.length === 0) {
            return frames;
        }
        task.calls += 1;
        return [...frames, { kind: "subagent_update", id: callId, toolUses: task.calls, lastTool: nameOf(update.toolCall) }];
    };

    return {
        started: (callId, call) => {
            if (call.type !== "task") {
                return [];
            }
            open.set(callId, { calls: 0, background: false });
            const args = TaskArgsSchema.parse(call.args);
            return [
                {
                    kind: "subagent",
                    id: callId,
                    subagentKind: "subagent",
                    ...opt("agentType", args.subagentType?.name ?? args.subagentType?.kind),
                    ...opt("description", args.description),
                    ...opt("model", args.model),
                },
            ];
        },
        nested: (callId, update) => {
            if (!open.has(callId)) {
                return [];
            }
            if (update.type === "text-delta" || update.type === "thinking-delta") {
                return update.text === "" ? [] : [{ kind: update.type === "text-delta" ? "delta" : "thinking", text: update.text, parentToolUseId: callId }];
            }
            return update.type === "tool-call-started" || update.type === "tool-call-completed" ? nestedCall(callId, update) : [];
        },
        completed: (callId, call) => {
            const task = open.get(callId);
            if (call.type !== "task" || task === undefined) {
                return [];
            }
            const result = TaskResultSchema.parse(call.result);
            if (result.status === "error") {
                open.delete(callId);
                return [{ kind: "subagent_update", id: callId, status: "failed", error: result.error?.message ?? "The subagent failed." }];
            }
            // Gone on in the background: its card is done, the subagent is not.
            if (result.value?.isBackground === true) {
                task.background = true;
                return [];
            }
            open.delete(callId);
            return [{ kind: "subagent_update", id: callId, status: "completed", ...opt("summary", lastSaid(result.value?.conversationSteps)) }];
        },
        settled: () =>
            [...open].flatMap(([callId, task]) => {
                if (!task.background) {
                    return [];
                }
                open.delete(callId);
                return [{ kind: "subagent_update" as const, id: callId, status: "completed" as const }];
            }),
    };
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

export const createCursorEventMapper = (
    cwd: string,
    holdText = false,
): VendorEventMapper<InteractionUpdate> & { readonly ending: (ranThrough: boolean) => AgentEvent[] } => {
    // Shell call in flight: output updates don't name their call; only one runs at a time, so 'last started' is it.
    let liveShell: { id: string; output: string } | undefined;
    const totals = usageTotals();
    const capture: TurnCapture = {};
    const cards = cardLedger(cwd);
    const subagents = cursorSubagents(cards);

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
                const opened = cards.opened(update.callId, call);
                if (opened.length === 0) {
                    return [];
                }
                if (call.type === "shell") {
                    liveShell = { id: update.callId, output: "" };
                }
                return [...opened, ...subagents.started(update.callId, call)];
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
                return [...cards.closed(update.callId, call), ...subagents.completed(update.callId, call)];
            }
            // A subagent's own steps, nested on the task call that started it.
            case "tool-call-delta":
                return subagents.nested(update.callId, update.taskUpdate);
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
                totals.add({
                    inputTokens: update.usage.inputTokens,
                    outputTokens: update.usage.outputTokens,
                    cacheReadTokens: update.usage.cacheReadTokens,
                    cacheCreationTokens: update.usage.cacheWriteTokens,
                });
                return [];
            }
            // Silently dropped, each already covered elsewhere:
            // partial-tool-call: argument streaming, rendered from the started frame
            // token-delta: a running count; usage reports properly at the end
            // step-* / summary*: the loop's own bookkeeping
            // user-message-appended: this turn's own prompt echoed back
            default:
                return [];
        }
    };

    // What a phase ends on: the subagents it sent into the background, which ended before a run that ran through did
    // (one cut short leaves them to the turn to close), then what the phase spent.
    const ending = (ranThrough: boolean): AgentEvent[] => {
        const spent = totals.frame();
        return [...(ranThrough ? subagents.settled() : []), ...(spent === undefined ? [] : [spent])];
    };

    return {
        map,
        usage: totals.frame,
        capture: () => capture,
        ending,
    };
};
