import { basename, isAbsolute, join } from "node:path";
import type { SessionUpdate, ToolCallContent as AcpToolCallContent, ToolCallLocation as AcpToolCallLocation } from "@agentclientprotocol/sdk";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AttachFrame, ToolCallContent, ToolCallLocation, TranscriptTool } from "@intentic/sandbox-contract";

/* The attach stream → ACP session/update, the mechanical reverse of the sandbox's acp-events.ts, mechanical
 * because the tool-call vocabulary (kind/status/locations/diff) was adopted from ACP verbatim. The daemon
 * hands over ROWS and changes to them (the fold ran on the daemon), so a tool arrives whole each time it moves
 * and the translator remembers which ids it has announced: the first sighting is ACP's `tool_call`, every
 * later one its `tool_call_update`.
 *
 * The one real transformation is paths: the wire carries workspace-root-relative paths; the editor's world is
 * the session cwd (the user's synced mirror of /work), so relative paths JOIN onto cwd and stray
 * sandbox-absolute /work paths are stripped first. A path outside the workspace passes through unchanged,
 * the diff text still renders inline; only jump-to-file misses.
 *
 * Documented drops (no ACP slot): the terminal and browser facts (the tmux panel has no local projection), init,
 * usage/rate_limit_info (account-level accounting), commands (the daemon relays ACP agents' commands,
 * advertising them back out would loop). Cards, errors and the session fact are control flow, handled in
 * bridge.ts, not here. */

// The container root every path in an ACP message is expressed against. Named once in @intentic/constants
// rather than spelled here, so a rename of the container's workspace dir moves this with it.
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
        // ACP's image content block wants base64 bytes; we only carry a path (see ToolCallContentSchema on
        // why). A resource_link points the editor at the synced mirror copy, which it can open itself.
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

// A helper's nested calls arrive on the same patch as their parent card, whole: every card in the tree is
// announced, so a delegation's own calls reach the editor too.
const cardsOf = (tool: TranscriptTool): TranscriptTool[] => [tool, ...(tool.children ?? []).flatMap(cardsOf)];

/** One session's translator: attach frames in, ACP updates out, remembering which tool calls it has announced. */
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
                // A notice is something that happened to the turn (a landed delta, a compaction, a stop): one
                // line beats silence. Prose and cards arrive through the patches that fill their rows.
                return patch.row.role === "notice" ? [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: patch.row.text } }] : [];
            case "replace":
                // Our todos ARE ACP's plan checklist (the reverse of acp-events.ts's plan→todos); priority is
                // synthesized, the checklist carries none.
                return patch.row.todos === undefined
                    ? []
                    : [{ sessionUpdate: "plan", entries: patch.row.todos.map((item) => ({ content: item.content, priority: "medium", status: item.status })) }];
            case "drop":
                return [];
        }
    };
};
