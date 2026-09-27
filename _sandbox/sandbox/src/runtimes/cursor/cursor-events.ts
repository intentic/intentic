import type { InteractionUpdate, NestedTaskUpdate, TodoItem as CursorTodo, ToolCall } from "@cursor/sdk";
import type { AgentEvent, TodoItem, ToolCallContent } from "@intentic/sandbox-contract";
import { z } from "zod";
import { diffContent, displayNameOf, toolLocations, toolTarget, workspacePath } from "../../agent/tools/tool-calls.js";
import { toolCallOpened, type TurnCapture, usageTotals, type VendorEventMapper } from "../decorators/vendor-events.js";
import { opt } from "../../opt.js";

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

// A call's card as it opens; `parent` is the task call whose subagent made it.
const openedCard = (callId: string, call: ToolCall, cwd: string, parent?: string): AgentEvent =>
    toolCallOpened({
        id: callId,
        name: nameOf(call),
        target: targetOf(call, cwd),
        locations: toolLocations(call.args, cwd),
        content: startedContent(call, cwd),
        parentToolUseId: parent,
    });

// A finished call's card: failed on the vendor's own error status, with what it produced.
const ResultStatusSchema = z.object({ status: z.string().optional().catch(undefined) }).catch({});
const closedCard = (callId: string, call: ToolCall): AgentEvent => {
    const failed = ResultStatusSchema.parse(call.result).status === "error";
    return { kind: "tool_call_update", id: callId, status: failed ? "failed" : "completed", ...opt("content", completedContent(call)) };
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

export const cursorSubagents = (cwd: string): CursorSubagents => {
    // Each subagent this run's task calls started and has not seen end, with its calls so far and whether it went on in
    // the background.
    const open = new Map<string, { calls: number; background: boolean }>();

    const nestedCall = (callId: string, update: Extract<NestedTaskUpdate, { type: "tool-call-started" | "tool-call-completed" }>): AgentEvent[] => {
        const task = open.get(callId);
        // A subagent's own checklist is its business, not the turn's.
        if (task === undefined || update.toolCall.type === "updateTodos") {
            return [];
        }
        if (update.type === "tool-call-completed") {
            return [closedCard(update.callId, update.toolCall)];
        }
        task.calls += 1;
        return [
            openedCard(update.callId, update.toolCall, cwd, callId),
            { kind: "subagent_update", id: callId, toolUses: task.calls, lastTool: nameOf(update.toolCall) },
        ];
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
    const subagents = cursorSubagents(cwd);

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
                if (call.type === "shell") {
                    liveShell = { id: update.callId, output: "" };
                }
                return [openedCard(update.callId, call, cwd), ...subagents.started(update.callId, call)];
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
                return [closedCard(update.callId, call), ...subagents.completed(update.callId, call)];
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
