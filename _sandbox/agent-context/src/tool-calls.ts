import { isAbsolute, relative } from "node:path";

// Cross-runtime tool-call vocabulary: what a call is called, what kind of act it was, what it aimed at, and the
// questions the turn readings ask of it (did it search, list, or reach a file). Every runtime maps its native calls
// through these, so the sandbox's live readings, its benches and the Claude Code plugin's transcript readings agree.

// ACP's tool kinds, the categories every card icon and reading is keyed on.
export type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";

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

const PATH_KEYS = ["file_path", "filePath", "notebook_path", "path"] as const;

// The file a call's input names, relative to `root`; undefined when it names none or one outside `root`. The plain
// reading, for a runtime with no state directories linked into its tree (the sandbox's own `toolLocations` resolves
// those as well).
export const toolPathsUnder = (input: unknown, root: string): { readonly path: string }[] | undefined => {
    if (typeof input !== "object" || input === null) {
        return undefined;
    }
    const record = input as Record<string, unknown>;
    for (const key of PATH_KEYS) {
        const value = record[key];
        if (typeof value !== "string") {
            continue;
        }
        const rel = isAbsolute(value) ? relative(root, value) : value;
        return rel === "" || rel === "." || rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? undefined : [{ path: rel.split("\\").join("/") }];
    }
    return undefined;
};
