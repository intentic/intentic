import type {
    ContentBlock,
    SessionUpdate,
    ToolCallContent as AcpToolCallContent,
    ToolCallLocation as AcpToolCallLocation,
    ToolKind as AcpToolKind,
} from "@agentclientprotocol/sdk";
import { type AgentEvent, type ToolCallContent, type ToolCallLocation, type ToolKind, ToolKindSchema } from "@intentic/sandbox-contract";
import { diffContent, toolCategoryOf, toolTarget, workspacePath } from "../../agent/tools/tool-calls.js";

// Maps ACP session/update notifications onto AgentEvent frames; an update with no UI mapping returns undefined. ACP's
// `plan` is a TodoWrite-style checklist, not intentic's approval plan frame, and maps to `todos`.

// ToolKind mirrors ACP's kind vocabulary verbatim; an unrecognized kind falls back to the shared name→kind table over
// the title.
const KINDS = new Set<string>(ToolKindSchema.options);
const categoryOf = (kind: AcpToolKind | null | undefined, title: string): ToolKind =>
    typeof kind === "string" && KINDS.has(kind) ? (kind as ToolKind) : toolCategoryOf(title);

const textOf = (content: ContentBlock): string => (content.type === "text" ? content.text : `[${content.type}]`);

const mapContent = (entries: AcpToolCallContent[] | null | undefined, cwd: string): ToolCallContent[] | undefined => {
    if (entries === null || entries === undefined || entries.length === 0) {
        return undefined;
    }
    const mapped: ToolCallContent[] = [];
    for (const entry of entries) {
        if (entry.type === "content") {
            mapped.push({ type: "text", text: textOf(entry.content) });
        } else if (entry.type === "diff") {
            // Diff paths keep a workspace-escaping value as-is; only locations enforce the workspace route space.
            mapped.push(diffContent(workspacePath(entry.path, cwd) ?? entry.path, entry.oldText ?? undefined, entry.newText));
        } else {
            // Terminal-embed entry: the live tmux session shows in the terminal panel via the adapter's terminal frame;
            // this is a pointer to it.
            mapped.push({ type: "text", text: "[running in the live terminal panel]" });
        }
    }
    return mapped.length > 0 ? mapped : undefined;
};

const mapLocations = (locations: AcpToolCallLocation[] | null | undefined, cwd: string): ToolCallLocation[] | undefined => {
    if (locations === null || locations === undefined || locations.length === 0) {
        return undefined;
    }
    const mapped = locations.flatMap((location): ToolCallLocation[] => {
        const path = workspacePath(location.path, cwd);
        if (path === undefined) {
            return [];
        }
        return [{ path, ...(typeof location.line === "number" && location.line > 0 ? { line: location.line } : {}) }];
    });
    return mapped.length > 0 ? mapped : undefined;
};

// One session/update → at most one AgentEvent. `undefined` = no UI mapping, dropped.
export const sessionUpdateEvent = (update: SessionUpdate, cwd: string): AgentEvent | undefined => {
    switch (update.sessionUpdate) {
        case "agent_message_chunk": {
            const text = textOf(update.content);
            return text === "" ? undefined : { kind: "delta", text };
        }
        case "agent_thought_chunk": {
            const text = textOf(update.content);
            return text === "" ? undefined : { kind: "thinking", text };
        }
        case "tool_call": {
            const target = toolTarget(update.rawInput);
            const locations = mapLocations(update.locations, cwd);
            const content = mapContent(update.content, cwd);
            return {
                kind: "tool_call",
                id: update.toolCallId,
                name: update.title,
                category: categoryOf(update.kind, update.title),
                status: update.status ?? "in_progress",
                ...(target !== undefined ? { target } : {}),
                ...(locations !== undefined ? { locations } : {}),
                ...(content !== undefined ? { content } : {}),
            };
        }
        case "tool_call_update": {
            const locations = mapLocations(update.locations, cwd);
            const content = mapContent(update.content, cwd);
            return {
                kind: "tool_call_update",
                id: update.toolCallId,
                ...(update.status !== null && update.status !== undefined ? { status: update.status } : {}),
                ...(content !== undefined ? { content } : {}),
                ...(locations !== undefined ? { locations } : {}),
            };
        }
        case "plan":
            // ACP's plan is a progress checklist (entries with status), the TodoWrite shape.
            return { kind: "todos", items: update.entries.map((entry) => ({ content: entry.content, status: entry.status })) };
        case "usage_update":
            return update.size > 0 ? { kind: "context_usage", tokens: update.used, contextWindow: update.size } : undefined;
        case "available_commands_update":
            // Agent's own slash commands, shown in the composer's `/` popover; invoking one is plain `/name …` prompt
            // text.
            return {
                kind: "commands",
                items: update.availableCommands.map((command) => ({
                    name: command.name,
                    description: command.description,
                    ...(command.input?.hint !== undefined ? { hint: command.input.hint } : {}),
                })),
            };
        // user_message_chunk, current_mode/config_option/session_info, plan_update/plan_removed: no UI mapping.
        default:
            return undefined;
    }
};
