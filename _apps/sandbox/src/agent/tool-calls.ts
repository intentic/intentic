import { isAbsolute, relative } from "node:path";
import type { ToolCallContent, ToolCallLocation, ToolKind } from "@intentic/sandbox-contract";

/* The cross-provider tool-call vocabulary: one home for deriving a tool_call frame's display name, ACP
 * category, target, locations, and structured diff content from whatever a backend's native stream carries.
 * Every adapter (Claude SDK blocks, Codex ThreadItems, OpenCode parts — and later ACP sessionUpdates) maps
 * through these instead of keeping its own copy, so the taxonomy can't drift per backend. */

// Flatten a tool_result block's content (a string, or an array of text/other blocks) to plain text — the
// edit diff / bash output the UI shows under the tool card. Non-text blocks are summarised by type. Shared by
// the live Claude stream and the session restore, so a replayed card reads exactly like the one it replaces.
export const resultText = (content: unknown): string => {
    if (typeof content === "string") {
        return content;
    }
    if (!Array.isArray(content)) {
        return "";
    }
    return content
        .map((block) => {
            const b = block as { type?: string; text?: string };
            return b.type === "text" && typeof b.text === "string" ? b.text : `[${b.type ?? "block"}]`;
        })
        .join("");
};

// Native tool ids → the display names the UI styles. Covers OpenCode's lowercase ids (bash/edit/patch/…);
// Claude SDK names are already display names and pass through. `todowrite` is intentionally absent — its
// checklist renders from the todos frame, never as a tool card.
const DISPLAY_NAMES: Record<string, string> = {
    bash: "Bash",
    edit: "Edit",
    write: "Write",
    read: "Read",
    grep: "Grep",
    glob: "Glob",
    list: "LS",
    webfetch: "WebFetch",
    websearch: "WebSearch",
    task: "Task",
    patch: "Edit",
};
export const displayNameOf = (raw: string): string => DISPLAY_NAMES[raw] ?? raw;

// The ONE display-name → ACP ToolKind table (case-insensitive), driving card icons and live-writes.
const CATEGORIES: ReadonlyArray<readonly [string, ToolKind]> = [
    ["read", "read"],
    ["edit", "edit"],
    ["write", "edit"],
    ["multiedit", "edit"],
    ["notebookedit", "edit"],
    ["bash", "execute"],
    ["bashoutput", "execute"],
    ["killshell", "execute"],
    ["grep", "search"],
    ["glob", "search"],
    ["ls", "search"],
    ["websearch", "search"],
    ["webfetch", "fetch"],
    ["task", "other"],
];
const CATEGORY_BY_NAME = new Map<string, ToolKind>(CATEGORIES);

// MCP tool-segment verbs → kind, matched as a suffix so `hashline_edit` / `db_read` style names categorize.
const MCP_VERBS: ReadonlyArray<readonly [string, ToolKind]> = [
    ["edit", "edit"],
    ["write", "edit"],
    ["read", "read"],
    ["search", "search"],
    ["fetch", "fetch"],
    ["delete", "delete"],
    ["move", "move"],
    ["run", "execute"],
    ["exec", "execute"],
];

// What a tool call *does*, from its (display) name. MCP names (`mcp__server__tool`, `server.tool`) categorize
// by their tool segment's trailing verb; anything unrecognized is `other`.
export const toolCategoryOf = (name: string): ToolKind => {
    const exact = CATEGORY_BY_NAME.get(name.toLowerCase());
    if (exact !== undefined) {
        return exact;
    }
    const segment = name.includes("__") ? name.split("__").pop() : name.includes(".") ? name.split(".").pop() : undefined;
    if (segment === undefined) {
        return "other";
    }
    const verb = segment.toLowerCase();
    for (const [suffix, kind] of MCP_VERBS) {
        if (verb === suffix || verb.endsWith(suffix)) {
            return kind;
        }
    }
    return "other";
};

// The file path / command / query a tool acts on, for the tool_call frame's target (the raw mono string on
// the card). Key order matters: the most specific spelling wins.
const TARGET_KEYS = ["file_path", "filePath", "notebook_path", "command", "pattern", "url", "path", "query"] as const;
export const toolTarget = (input: unknown): string | undefined => {
    if (typeof input !== "object" || input === null) {
        return undefined;
    }
    const record = input as Record<string, unknown>;
    for (const key of TARGET_KEYS) {
        const value = record[key];
        if (typeof value === "string") {
            return value;
        }
    }
    return undefined;
};

// Normalize a tool path onto the workspace-root-relative forward-slash route space, or undefined when it
// escapes the workspace (the tree/file routes can't address it). Relative inputs are cwd-relative, which
// IS the route space — worktree cwds mirror the /work layout.
export const workspacePath = (raw: string, cwd: string): string | undefined => {
    const rel = isAbsolute(raw) ? relative(cwd, raw) : raw;
    if (rel === "" || rel === "." || rel === ".." || rel.startsWith("../")) {
        return undefined;
    }
    return rel;
};

const PATH_KEYS = ["file_path", "filePath", "notebook_path", "path"] as const;

// The workspace files a tool call touches, for clickable cards and live-writes. `line` comes from Read's
// 1-based `offset` when present. Undefined when the input names no workspace-addressable file.
export const toolLocations = (input: unknown, cwd: string): ToolCallLocation[] | undefined => {
    if (typeof input !== "object" || input === null) {
        return undefined;
    }
    const record = input as Record<string, unknown>;
    for (const key of PATH_KEYS) {
        const value = record[key];
        if (typeof value !== "string") {
            continue;
        }
        const path = workspacePath(value, cwd);
        if (path === undefined) {
            return undefined;
        }
        const offset = record["offset"];
        return [{ path, ...(typeof offset === "number" && offset > 0 ? { line: offset } : {}) }];
    }
    return undefined;
};

// One side of a diff can be a whole written file — cap it so a giant Write can't flood the event stream.
const DIFF_SIDE_CAP = 32_000;
const capSide = (text: string): { text: string; clipped: boolean } =>
    text.length > DIFF_SIDE_CAP ? { text: text.slice(0, DIFF_SIDE_CAP), clipped: true } : { text, clipped: false };

// A capped structured diff content entry — the one constructor every diff on the wire goes through, whether
// derived from an Edit/Write input (below) or arriving ready-made from an ACP agent.
export const diffContent = (path: string, oldText: string | undefined, newText: string): ToolCallContent => {
    const oldCapped = oldText !== undefined ? capSide(oldText) : undefined;
    const newCapped = capSide(newText);
    return {
        type: "diff",
        path,
        ...(oldCapped !== undefined ? { oldText: oldCapped.text } : {}),
        newText: newCapped.text,
        ...(oldCapped?.clipped === true || newCapped.clipped ? { truncated: true } : {}),
    };
};

// Structured diff content derived from an Edit/Write-style tool INPUT — known at call time, no result needed.
// Handles both spelling families (Claude old_string / OpenCode oldString). Unrecognized shapes degrade to
// undefined (the card falls back to target-only) — never throw. The diff keeps a workspace-escaping path
// as-is for display; only locations enforce the route space.
export const editDiffContent = (name: string, input: unknown, cwd: string): ToolCallContent | undefined => {
    if (typeof input !== "object" || input === null) {
        return undefined;
    }
    const record = input as Record<string, unknown>;
    const rawPath = record["file_path"] ?? record["filePath"] ?? record["notebook_path"];
    if (typeof rawPath !== "string") {
        return undefined;
    }
    const path = workspacePath(rawPath, cwd) ?? rawPath;
    if (name === "Edit") {
        const oldText = record["old_string"] ?? record["oldString"];
        const newText = record["new_string"] ?? record["newString"];
        if (typeof oldText !== "string" || typeof newText !== "string") {
            return undefined;
        }
        return diffContent(path, oldText, newText);
    }
    if (name === "Write" || name === "NotebookEdit") {
        const content = record[name === "Write" ? "content" : "new_source"];
        if (typeof content !== "string") {
            return undefined;
        }
        return diffContent(path, undefined, content);
    }
    return undefined;
};
