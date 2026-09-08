import { isAbsolute, relative } from "node:path";
import type { ToolCallContent, ToolCallLocation, ToolKind } from "@intentic/sandbox-contract";
import { claudeStatePath } from "../../sessions/session-store.js";

// Cross-provider tool-call vocabulary: derives display name, category, target, locations and diff content from any
// backend's native stream. Every adapter maps through these instead of keeping its own copy.

// Flattens a tool_result block's content (string or array of text/other blocks) to plain text; non-text blocks
// summarize by type. Shared by the live stream and session restore so a replayed card matches the original.
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

// Native tool ids to display names; OpenCode's lowercase ids map over, Claude SDK names pass through.
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

// Browser tool names spelled out for a reader (`Browser navigate`, `Browser click`); which server handled it is
// dropped, since the call's own `account` argument already names that. `take_screenshot` loses its verb; other names
// keep their own.
const BROWSER_TOOL = /^mcp__.+__browser_(.+)$/;
const BROWSER_VERB_NAMES: Record<string, string> = { take_screenshot: "screenshot" };
const browserDisplayName = (raw: string): string | undefined => {
    const verb = BROWSER_TOOL.exec(raw)?.[1];
    return verb === undefined ? undefined : `Browser ${(BROWSER_VERB_NAMES[verb] ?? verb).replaceAll("_", " ")}`;
};

export const displayNameOf = (raw: string): string => DISPLAY_NAMES[raw] ?? browserDisplayName(raw) ?? raw;

// Display name to ACP ToolKind (case-insensitive), the one table driving card icons and live-writes.
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

// MCP tool-segment verb to kind, matched as a suffix so names like `hashline_edit`/`db_read` categorize.
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

// Browsing splits into three acts the suffix rule gets wrong:
// - going somewhere → fetch
// - doing something there → execute
// - looking at the result → read
// Unlisted verbs default to execute, not other.
const BROWSER_VERB_KINDS: Record<string, ToolKind> = {
    navigate: "fetch",
    navigate_back: "fetch",
    snapshot: "read",
    take_screenshot: "read",
    console_messages: "read",
    network_requests: "read",
    network_request: "read",
    tabs: "read",
};

// What a tool call does, from its display name. MCP names (`mcp__server__tool`, `server.tool`) categorize by their tool
// segment's trailing verb; anything unrecognized is `other`.
export const toolCategoryOf = (name: string): ToolKind => {
    const exact = CATEGORY_BY_NAME.get(name.toLowerCase());
    if (exact !== undefined) {
        return exact;
    }
    const browserVerb = BROWSER_TOOL.exec(name)?.[1];
    if (browserVerb !== undefined) {
        return BROWSER_VERB_KINDS[browserVerb] ?? "execute";
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

// Programs that go looking for code; `ls`/`tree` included since the LS tool itself categorizes as `search`.
const SEARCH_COMMANDS = new Set(["iq", "grep", "rg", "ag", "ack", "find", "fd", "fdfind", "locate", "ls", "tree"]);

// Shell programs that open file contents directly; arrive as `execute`, the same transition as Read/Edit.
const FILE_WORK_COMMANDS = new Set(["cat", "sed", "head", "tail", "less", "more", "bat", "awk"]);

// Splits a shell line on statement separators, never on a pipe: `git log | grep fix` filters output, not a search.
const statementsOf = (command: string): string[] => command.split(/&&|\|\||;|\n/);

// Each statement's leading program, past an env prefix and a path: `cd /work && iq q ...` runs two, the second matters.
const commandHeads = (command: string): string[] =>
    statementsOf(command).map((statement) => {
        const head =
            statement
                .trim()
                .split(/\s+/)
                .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "";
        return head.split("/").pop() ?? head;
    });

// Whether a call went looking for code: category alone misses this workspace's search tool, a CLI (`iq q ...`) that
// arrives as Bash and categorizes as `execute`.
export const isSearchCall = (call: { readonly category: ToolKind; readonly target?: string | undefined }): boolean => {
    if (call.category === "search") {
        return true;
    }
    if (call.category !== "execute" || call.target === undefined) {
        return false;
    }
    return commandHeads(call.target).some((head) => SEARCH_COMMANDS.has(head));
};

// Programs that list a directory, as opposed to searching inside one; a subset of SEARCH_COMMANDS.
const LISTING_COMMANDS = new Set(["ls", "tree"]);

// Native tool names that list a directory, lowercased; `list` is OpenCode's id for Claude Code's LS.
const LISTING_TOOLS = new Set(["ls", "list"]);

// How far below `root` a listing's target sits, or undefined off-root; `~` is the sandbox home, not the workspace, so
// it scores as elsewhere.
const depthBelow = (raw: string, root: string): number | undefined => {
    const path = raw.replace(/^["']|["']$/g, "").replace(/\/+$/, "");
    if (path === "" || path === "." || path === "./") {
        return 0;
    }
    const rel = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//, "");
    if (rel === "") {
        return 0;
    }
    return rel === ".." || rel.startsWith("../") ? undefined : rel.split("/").length;
};

// A listing one level below `root` or shallower is orientation; deeper is a turn already looking at something it chose.
// `root` is the agent's own namespace root; a glob argument is a question about files, not a listing.
export const isRootListing = (
    call: { readonly name?: string | undefined; readonly category: ToolKind; readonly target?: string | undefined },
    root: string,
): boolean => {
    const shallow = (path: string): boolean => {
        const depth = depthBelow(path, root);
        return depth !== undefined && depth <= 1;
    };
    if (call.name !== undefined && LISTING_TOOLS.has(call.name.toLowerCase())) {
        // The tool's target is its path, and a call that named none listed where it stood.
        return call.target === undefined || shallow(call.target);
    }
    if (call.category !== "execute" || call.target === undefined) {
        return false;
    }
    return statementsOf(call.target).some((statement) => {
        // Everything past a pipe belongs to the filter, not to the listing: `ls | head -30` lists the same
        // directory `ls` does, and reading `head` as an argument to it would score it as a deep one.
        const words = (statement.split("|")[0] ?? "").trim().split(/\s+/);
        const head = words.find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "";
        if (!LISTING_COMMANDS.has(head.split("/").pop() ?? head)) {
            return false;
        }
        const args = words.slice(words.indexOf(head) + 1).filter((word) => word !== "" && !word.startsWith("-"));
        return args.length === 0 ? true : !args.some((arg) => arg.includes("*")) && args.some(shallow);
    });
};

// Whether a call reached file content. Independent of search counting: one compound call can do both (`rg ...; sed -n
// ...`).
export const isFileWorkCall = (call: { readonly category: ToolKind; readonly target?: string | undefined }): boolean => {
    if (call.category === "read" || call.category === "edit") {
        return true;
    }
    if (call.category !== "execute" || call.target === undefined) {
        return false;
    }
    return commandHeads(call.target).some((head) => FILE_WORK_COMMANDS.has(head));
};

// Whether a compound call's search happened before its file work; a search-only native tool always opens by definition.
// `cat file; rg term` is not opening; `rg term; sed -n ...` is.
export const searchPrecedesFileWork = (call: { readonly category: ToolKind; readonly target?: string | undefined }): boolean => {
    if (call.category === "search") {
        return true;
    }
    if (call.category !== "execute" || call.target === undefined) {
        return false;
    }
    const heads = commandHeads(call.target);
    const searchAt = heads.findIndex((head) => SEARCH_COMMANDS.has(head));
    const workAt = heads.findIndex((head) => FILE_WORK_COMMANDS.has(head));
    return searchAt !== -1 && (workAt === -1 || searchAt < workAt);
};

// Key order matters, most specific wins; `element` is @playwright/mcp's own readable click/type target.
const TARGET_KEYS = ["file_path", "filePath", "notebook_path", "command", "pattern", "url", "element", "path", "query"] as const;
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

// Normalizes a tool path onto the workspace-root-relative, forward-slash route space; undefined if it escapes the
// workspace. Relative inputs are cwd-relative, which is already the route space.
export const workspacePath = (raw: string, cwd: string): string | undefined => {
    // A `~/.claude/...` path is not an escape: it symlinks onto the workspace, resolved before the cwd test.
    const state = claudeStatePath(raw);
    if (state !== undefined) {
        return state;
    }
    const rel = isAbsolute(raw) ? relative(cwd, raw) : raw;
    if (rel === "" || rel === "." || rel === ".." || rel.startsWith("../")) {
        return undefined;
    }
    return rel;
};

const PATH_KEYS = ["file_path", "filePath", "notebook_path", "path"] as const;

// Workspace files a tool call touches, for clickable cards and live-writes; `line` comes from Read's 1-based `offset`.
// Undefined when the input names no workspace-addressable file.
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

// Caps one side of a diff so a giant Write can't flood the event stream.
const DIFF_SIDE_CAP = 32_000;
const capSide = (text: string): { text: string; clipped: boolean } =>
    text.length > DIFF_SIDE_CAP ? { text: text.slice(0, DIFF_SIDE_CAP), clipped: true } : { text, clipped: false };

// The one constructor every diff on the wire goes through, whether derived from an Edit/Write input or arriving
// ready-made from an ACP agent.
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

// Structured diff content derived from an Edit/Write-style input, known at call time; handles both spelling families.
// Unrecognized shapes degrade to undefined, never throw; a workspace-escaping path is kept as-is for display.
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
