import { basename, isAbsolute, join } from "node:path";
import type { SessionUpdate, ToolCallContent as AcpToolCallContent, ToolCallLocation as AcpToolCallLocation } from "@agentclientprotocol/sdk";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AttachFrame, ToolCallContent, ToolCallLocation, TranscriptTool } from "@intentic/sandbox-contract";

// Attach stream to ACP session/update, the mechanical reverse of acp-events.ts; a tool's first sighting is `tool_call`,
// every later one `tool_call_update`.
// Paths: workspace-root-relative joins onto the session cwd, a stray sandbox-absolute /work path is stripped first;
// anything else passes through unchanged.
// Drops terminal/browser facts, init, usage/rate-limit, and commands (no ACP slot); cards, errors and the session fact
// are handled in bridge.ts.

// Container root every path in an ACP message is expressed against; named once in @intentic/constants.
const SANDBOX_ROOT = WORKSPACE_ROOT;

export const editorPath = (path: string, cwd: string): string => {
    if (isAbsolute(path)) {
        if (path === SANDBOX_ROOT) {
            return cwd;
        }
        return path.startsWith(`${SANDBOX_ROOT}/`) ? join(cwd, path.slice(SANDBOX_ROOT.length + 1)) : path;
    }
    return join(cwd, path);
};

const mapLocations = (locations: readonly ToolCallLocation[] | undefined, cwd: string): AcpToolCallLocation[] | undefined =>
    locations === undefined
        ? undefined
        : locations.map((location) => ({ path: editorPath(location.path, cwd), ...(location.line !== undefined ? { line: location.line } : {}) }));

const mapContentEntry = (entry: ToolCallContent, cwd: string): AcpToolCallContent => {
    if (entry.type === "text") {
        return { type: "content", content: { type: "text", text: entry.text } };
    }
    if (entry.type === "image") {
        // ACP's image block wants base64; a resource_link instead points the editor at the synced mirror copy.
        const path = editorPath(entry.path, cwd);
        return { type: "content", content: { type: "resource_link", uri: `file://${path}`, name: basename(path) } };
    }
    return {
        type: "diff",
        path: editorPath(entry.path, cwd),
        ...(entry.oldText !== undefined ? { oldText: entry.oldText } : {}),
        newText: entry.newText,
    };
};

const mapContent = (content: readonly ToolCallContent[] | undefined, cwd: string): AcpToolCallContent[] | undefined =>
    content === undefined ? undefined : content.map((entry) => mapContentEntry(entry, cwd));

const toolCall = (tool: TranscriptTool, cwd: string): SessionUpdate => {
    const locations = mapLocations(tool.locations, cwd);
    const content = mapContent(tool.content, cwd);
    return {
        sessionUpdate: "tool_call",
        toolCallId: tool.id,
        title: tool.target !== undefined ? `${tool.name}: ${tool.target}` : tool.name,
        kind: tool.category,
        status: tool.status,
        ...(locations !== undefined ? { locations } : {}),
        ...(content !== undefined ? { content } : {}),
    };
};

const toolCallUpdate = (tool: TranscriptTool, cwd: string): SessionUpdate => {
    const locations = mapLocations(tool.locations, cwd);
    const content = mapContent(tool.content, cwd);
    return {
        sessionUpdate: "tool_call_update",
        toolCallId: tool.id,
        status: tool.status,
        ...(locations !== undefined ? { locations } : {}),
        ...(content !== undefined ? { content } : {}),
    };
};

// A helper's nested calls ride the same patch as their parent, whole, so every card in the tree gets announced.
const cardsOf = (tool: TranscriptTool): TranscriptTool[] => [tool, ...(tool.children ?? []).flatMap(cardsOf)];

/** One session's translator: attach frames in, ACP updates out, tracking which tool calls it has announced. */
export const createTranslator = (cwd: string): ((frame: AttachFrame) => SessionUpdate[]) => {
    const announced = new Set<string>();
    return (frame) => {
        if (frame.kind === "fact") {
            return frame.fact.kind === "context_usage" ? [{ sessionUpdate: "usage_update", used: frame.fact.tokens, size: frame.fact.contextWindow }] : [];
        }
        if (frame.kind !== "patch") {
            return [];
        }
        const { patch } = frame;
        switch (patch.op) {
            case "text":
                return [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: patch.text } }];
            case "thinking":
                return [{ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: patch.text } }];
            case "tool":
                return cardsOf(patch.tool).map((tool) => {
                    if (announced.has(tool.id)) {
                        return toolCallUpdate(tool, cwd);
                    }
                    announced.add(tool.id);
                    return toolCall(tool, cwd);
                });
            case "append":
                // A notice becomes one line; prose and cards arrive through their own patches instead.
                return patch.row.role === "notice" ? [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: patch.row.text } }] : [];
            case "replace":
                // Todos are ACP's plan checklist, reversed from acp-events.ts; priority is synthesized, unlike the
                // checklist.
                return patch.row.todos === undefined
                    ? []
                    : [{ sessionUpdate: "plan", entries: patch.row.todos.map((item) => ({ content: item.content, priority: "medium", status: item.status })) }];
            case "drop":
                return [];
        }
    };
};
