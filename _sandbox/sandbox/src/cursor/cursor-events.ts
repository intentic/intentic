import type { InteractionUpdate, TodoItem as CursorTodo, ToolCall } from "@cursor/sdk";
import type { AgentEvent, TodoItem, ToolCallContent } from "@intentic/sandbox-contract";
import { diffContent, displayNameOf, toolCategoryOf, toolLocations, toolTarget, workspacePath } from "../agent/tool-calls.js";

/* PURE MAPPING OF CURSOR'S INTERACTION UPDATES ONTO AgentEvent FRAMES: the Cursor-native producer of the
 * contract's tool-call vocabulary, the pi-events.ts shape rebuilt for a callback transport. Updates with no UI
 * meaning are dropped rather than passed through as noise, which is the streamSdk philosophy every adapter
 * here follows.
 *
 * ONE SOURCE, DELIBERATELY. The SDK offers two views of a run: `run.stream()`, which yields whole messages,
 * and `send({ onDelta })`, which yields incremental updates. They overlap — a tool call appears in both — so
 * consuming both would double every card. The delta stream is the richer of the two (it alone carries text and
 * thinking token-by-token, and shell output as it is produced), so it is the one this reads, and the run's own
 * terminal result supplies what a delta stream by definition cannot: whether the whole thing succeeded.
 *
 * Stateful only where the protocol is: an in-flight shell call's output arrives on an update that does not
 * name which call it belongs to, so the mapper remembers the last one it started. */

// What a plan phase holds back instead of streaming: the assistant's text IS the plan. `errored` suppresses the
// plan frame, since a plan must never be proposed out of partial output that already failed.
export interface CursorTurnCapture {
    planText?: string;
    errored?: boolean;
}

export interface CursorEventMapper {
    // One Cursor update → its frames (usually 0 or 1; a completed tool call can carry a status and content).
    readonly map: (update: InteractionUpdate) => AgentEvent[];
    // The turn's usage frame, once, undefined when the run reported none.
    readonly usage: () => AgentEvent | undefined;
    // What the turn held back, read at settle: a plan phase's text, and whether an error frame went out.
    readonly capture: () => CursorTurnCapture;
}

/* Cursor's tool ids → the display names the cards are styled by. `shell` becoming "Bash" is the load-bearing
 * one: it is the same act every other runtime calls Bash, and a card headed "shell" would sort, filter and
 * icon differently from an identical command run by any other provider. The rest are the tool's own name made
 * readable. `updateTodos` is deliberately absent — its checklist renders from the `todos` frame and never as a
 * card, the same rule Claude's `todowrite` follows. */
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

/* An MCP call is named for the TOOL IT CALLED, not for the fact that MCP carried it. `mcp` as a card title
 * would collapse every connected account's every action into one indistinguishable row, which is exactly the
 * information the card exists to carry. The provider/tool pair is spelled the way the shared taxonomy already
 * recognises (`server__tool`), so categorisation by trailing verb works on it for free. */
const nameOf = (call: ToolCall): string => {
    if (call.type === "mcp") {
        const args = call.args as { providerIdentifier?: unknown; toolName?: unknown };
        const tool = typeof args.toolName === "string" ? args.toolName : "call";
        const provider = typeof args.providerIdentifier === "string" ? args.providerIdentifier : "mcp";
        return displayNameOf(`mcp__${provider}__${tool}`);
    }
    return CURSOR_TOOL_NAMES[call.type] ?? displayNameOf(call.type);
};

/* WHICH PATH A CALL IS ABOUT, in Cursor's own argument spellings. The shared `toolTarget` reads the Claude and
 * OpenCode spellings (`file_path`, `filePath`, `path`) and gets Cursor's file tools right by luck — they use
 * `path` — but not `glob` (`targetDirectory`) or `write` (`path`, same). Named here rather than widened in the
 * shared helper, because these are one vendor's argument names and the shared table is not the place to
 * accumulate five vendors' worth of them. */
const targetOf = (call: ToolCall, cwd: string): string | undefined => {
    const args = call.args as Record<string, unknown>;
    const raw = args["path"] ?? args["targetDirectory"] ?? args["filePath"];
    if (typeof raw === "string" && raw !== "") {
        return workspacePath(raw, cwd) ?? raw;
    }
    return toolTarget(call.args);
};

// Structured content known at CALL time, before any result exists: a write's whole new file is a diff we can
// draw immediately. An edit cannot be drawn yet — Cursor's edit args carry only the path, and the change
// arrives as a diff string on the result (see `completedContent`), which is the honest moment for it.
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

/* What a finished call shows under its card. Three shapes, in order of how much they say:
 *   · an edit hands back a unified diff, which is the whole point of the card;
 *   · a shell hands back stdout and stderr, joined the way a terminal would have shown them;
 *   · everything else is summarised as text, and a failure shows the vendor's own message rather than a
 *     generic one, because "no such file" and "permission denied" send a reader to different places. */
const completedContent = (call: ToolCall): ToolCallContent[] | undefined => {
    const result = call.result as Record<string, unknown> | undefined;
    if (result === undefined) {
        return undefined;
    }
    if (result["status"] === "error") {
        const message = text(result["message"]) ?? "The tool call failed.";
        return [{ type: "text", text: message }];
    }
    /* An edit's change arrives ALREADY RENDERED, as a unified-diff string, and that is why it goes out as text
     * rather than as the structured `diff` content every other adapter produces. The structured shape wants
     * the before and after of the file so the client can draw its own two-pane view; Cursor hands back the
     * drawing instead, and there is no honest way to reconstruct the halves from it. Passing the vendor's own
     * diff through is the whole change, correctly, in a monospace block — where inventing `newText` from a
     * patch would risk showing a diff that does not match what landed on disk. */
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

/* Cursor's four todo states onto the contract's three.
 *
 * `cancelled` is the one that has to be decided rather than translated, and both available answers are a
 * little wrong. Left as `pending` it is an item the checklist will never finish, so a card sits at "3 of 4"
 * forever with nothing anyone can do about it. Read as `completed` it is off the list, which is at least the
 * true status of a thing that will not be done. The second is the smaller lie, and it is the one that lets a
 * finished turn look finished. */
const TODO_STATUS: Record<string, TodoItem["status"]> = {
    pending: "pending",
    inProgress: "in_progress",
    completed: "completed",
    cancelled: "completed",
};

const toTodos = (todos: readonly CursorTodo[]): TodoItem[] =>
    todos.map((todo) => ({ content: todo.content, status: TODO_STATUS[todo.status] ?? "pending" }));

export const createCursorEventMapper = (cwd: string, holdText = false): CursorEventMapper => {
    // The shell call currently in flight. Cursor's shell-output updates carry the output and not the call it
    // belongs to, so the correlation has to be remembered here; a turn runs its commands one at a time, which
    // is what makes "the last one started" the right answer rather than a guess.
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
                // The checklist is a frame of its own, never a card: a todo list rendered as a tool call is
                // both duplicated (the panel already draws it) and useless (nobody wants "updateTodos" in a
                // transcript). Emitted on START because the args already carry the new list.
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
            /* Live shell output, on an UNTYPED passthrough: the SDK declares this update's `event` as a bare
             * record, so its field names are not part of the published contract and could change under us.
             * Read for the handful of spellings a stream chunk plausibly arrives under, and dropped entirely
             * when none matches — a card that shows its output a moment later, when the call completes, is a
             * far better failure than one that throws mid-turn on a renamed field. */
            case "shell-output-delta": {
                if (liveShell === undefined) {
                    return [];
                }
                const event = update.event as Record<string, unknown>;
                const chunk = text(event["output"]) ?? text(event["chunk"]) ?? text(event["data"]) ?? text(event["text"]);
                if (chunk === undefined) {
                    return [];
                }
                // Snapshot semantics: `content` REPLACES on every update, so the accumulated output is sent
                // rather than the delta, which would otherwise show only the most recent line.
                liveShell.output += chunk;
                return [{ kind: "tool_call_update", id: liveShell.id, content: [{ type: "text", text: liveShell.output }] }];
            }
            /* A turn can end without reporting usage, so the flag is set by the READING rather than by the
             * event: an absent one must leave the usage frame unsent, not send a row of zeros, because zero
             * tokens is a claim and "we were not told" is the truth. Summed rather than assigned because one
             * send can end several turns (a plan phase and its execution are two). */
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
            /* Everything else is deliberately silent. `partial-tool-call` and `tool-call-delta` are argument
             * streaming, which the card renders from the started frame instead; `token-delta` is a running
             * count the usage frame reports properly at the end; `step-*` and `summary*` describe the loop's
             * own bookkeeping; `user-message-appended` is this turn's own prompt coming back. */
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
