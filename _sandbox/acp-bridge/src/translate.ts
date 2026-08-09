import { basename, isAbsolute, join } from "node:path";
import type { SessionUpdate, ToolCallContent as AcpToolCallContent, ToolCallLocation as AcpToolCallLocation } from "@agentclientprotocol/sdk";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent, ToolCallContent, ToolCallLocation } from "@intentic/sandbox-contract";

/* AgentEvent → ACP session/update, the mechanical reverse of the sandbox's acp-events.ts — mechanical
 * because the tool-call vocabulary (kind/status/locations/diff) was adopted from ACP verbatim. The one real
 * transformation is paths: the wire carries workspace-root-relative paths; the editor's world is the
 * session cwd (the user's synced mirror of /work), so relative paths JOIN onto cwd and stray
 * sandbox-absolute /work paths are stripped first. A path outside the workspace passes through unchanged —
 * the diff text still renders inline; only jump-to-file misses.
 *
 * Documented drops (no ACP slot): terminal (the tmux panel has no local projection), init,
 * usage/rate_limit_info (account-level accounting), compact, checkpoint (sandbox-side restore), commands
 * (the daemon relays ACP agents' commands — advertising them back out would loop). plan/question/error/done
 * are control flow, handled in bridge.ts, not here. */

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

// One AgentEvent → at most one session update. `undefined` = dropped (documented above) or control flow the
// bridge handles itself (session/plan/question/error/done).
export const sessionUpdateOf = (event: AgentEvent, cwd: string): SessionUpdate | undefined => {
    switch (event.kind) {
        case "delta":
            return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: event.text } };
        case "thinking":
            return { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: event.text } };
        case "tool_call": {
            const locations = mapLocations(event.locations, cwd);
            const content = mapContent(event.content, cwd);
            return {
                sessionUpdate: "tool_call",
                toolCallId: event.id,
                title: event.target !== undefined ? `${event.name}: ${event.target}` : event.name,
                kind: event.category,
                status: event.status,
                ...(locations !== undefined ? { locations } : {}),
                ...(content !== undefined ? { content } : {}),
            };
        }
        case "tool_call_update": {
            const locations = mapLocations(event.locations, cwd);
            const content = mapContent(event.content, cwd);
            return {
                sessionUpdate: "tool_call_update",
                toolCallId: event.id,
                ...(event.status !== undefined ? { status: event.status } : {}),
                ...(locations !== undefined ? { locations } : {}),
                ...(content !== undefined ? { content } : {}),
            };
        }
        case "todos":
            // Our todos ARE ACP's plan checklist (the reverse of acp-events.ts's plan→todos); priority is
            // synthesized — the checklist carries none.
            return {
                sessionUpdate: "plan",
                entries: event.items.map((item) => ({ content: item.content, priority: "medium", status: item.status })),
            };
        case "context_usage":
            return { sessionUpdate: "usage_update", used: event.tokens, size: event.contextWindow };
        case "landed": {
            // Defensive (v1 never sends isolated turns): a one-line summary beats silence if it ever arrives.
            const text = event.landed
                ? "Changes landed in the main tree."
                : `Changes stayed in the worktree — conflicts: ${(event.conflicts ?? []).map((conflict) => conflict.paths.join(", ")).join("; ")}.`;
            return { sessionUpdate: "agent_message_chunk", content: { type: "text", text } };
        }
        default:
            return undefined;
    }
};
