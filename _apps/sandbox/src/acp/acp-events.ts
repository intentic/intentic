import type {
    ContentBlock,
    SessionUpdate,
    ToolCallContent as AcpToolCallContent,
    ToolCallLocation as AcpToolCallLocation,
    ToolKind as AcpToolKind,
} from "@agentclientprotocol/sdk";
import type { AgentEvent, ToolCallContent, ToolCallLocation, ToolKind } from "@intentic/sandbox-contract";
import { diffContent, toolCategoryOf, toolTarget, workspacePath } from "../agent/tool-calls.js";

/* Pure mapping of ACP session/update notifications onto AgentEvent frames — the ACP-native producer of the
 * contract's tool-call vocabulary, so kind/status/locations/diff pass through near-verbatim. Updates with no
 * UI mapping are dropped (the streamSdk philosophy). ACP's `plan` is a TodoWrite-style progress checklist,
 * NOT intentic's approval plan frame — it maps to `todos`. */

// Our ToolKind is ACP's vocabulary verbatim; anything newer (e.g. switch_mode) falls back through the shared
// name→kind table over the title.
const KINDS = new Set<string>(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"]);
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
            // The wire diff keeps a workspace-escaping path as-is for display; only locations enforce the
            // route space (the tool-calls.ts convention).
            mapped.push(diffContent(workspacePath(entry.path, cwd) ?? entry.path, entry.oldText ?? undefined, entry.newText));
        }
        // terminal entries are dropped: a foreign agent's terminal ids have no tmux-panel mapping (phase 2).
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
        // user_message_chunk (prompt echo), available_commands/current_mode/config_option/session_info updates,
        // and the experimental plan_update/plan_removed have no UI mapping — dropped.
        default:
            return undefined;
    }
};
