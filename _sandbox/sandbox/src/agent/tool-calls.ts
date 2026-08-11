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

/* THE BROWSER TOOLS, SPELLED AS SOMETHING A PERSON READS.
 *
 * @playwright/mcp's tools arrive as `mcp__web__browser_navigate` / `mcp__reddit__browser_click`, and a card
 * headed with that string tells the user nothing they came for. Which SERVER it was is the one part that
 * doesn't earn its place: the credential-free browser and a logged-in profile do the same things, and where a
 * platform matters the URL on the card already names it. What is left — "Browser navigate", "Browser click" —
 * groups on sight in a scrolling transcript and says exactly what happened.
 *
 * `take_screenshot` is the one verb that reads badly transliterated ("Browser take screenshot"), so it loses
 * its verb; every other name is the tool's own, underscores opened out. */
const BROWSER_TOOL = /^mcp__.+__browser_(.+)$/;
const BROWSER_VERB_NAMES: Record<string, string> = { take_screenshot: "screenshot" };
const browserDisplayName = (raw: string): string | undefined => {
    const verb = BROWSER_TOOL.exec(raw)?.[1];
    return verb === undefined ? undefined : `Browser ${(BROWSER_VERB_NAMES[verb] ?? verb).replaceAll("_", " ")}`;
};

export const displayNameOf = (raw: string): string => DISPLAY_NAMES[raw] ?? browserDisplayName(raw) ?? raw;

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

/* Browsing splits into three acts, and the suffix rule above gets all three wrong (`browser_click` ends in no
 * known verb at all, so every one of them landed on `other` and drew the generic cog).
 *   · going somewhere        → fetch   (the globe: same act as WebFetch, done in a real page)
 *   · doing something there  → execute (a click, a keystroke, a form — the browser's side effects)
 *   · looking at the result  → read    (a snapshot, a screenshot, the console, the network log)
 * Anything not listed is an act on the page, so `execute` is the floor rather than `other`. */
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

// What a tool call *does*, from its (display) name. MCP names (`mcp__server__tool`, `server.tool`) categorize
// by their tool segment's trailing verb; anything unrecognized is `other`.
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

/* The programs that go looking for code. `ls`/`tree` are in because the LS TOOL already categorizes as
 * `search` above, and a taxonomy that counts one spelling of a directory listing and not the other is one that
 * reports whichever spelling the model happened to reach for. */
const SEARCH_COMMANDS = new Set(["iq", "grep", "rg", "ag", "ack", "find", "fd", "fdfind", "locate", "ls", "tree"]);

/* Shell programs that directly open file contents. They arrive as `execute`, even though they mark the same
 * transition as the native Read/Edit tools: the model has stopped orienting and reached the work. Pipes are
 * deliberately not split by commandHeads, so `rg needle | head` remains a search and does not pretend that
 * truncating its stdout opened a file. */
const FILE_WORK_COMMANDS = new Set(["cat", "sed", "head", "tail", "less", "more", "bat", "awk"]);

/* Each statement's leading program, past an env prefix and a path — `cd /work && iq q "…"` runs two and the
 * second is the one that matters, and `/usr/bin/rg` is `rg`.
 *
 * Split on statement separators and NEVER on a pipe: `git log | grep fix` filters a command's own output, which
 * is not the model looking for code, and counting it would put ordinary shell plumbing in a search figure. */
const commandHeads = (command: string): string[] =>
    command.split(/&&|\|\||;|\n/).map((statement) => {
        const head =
            statement
                .trim()
                .split(/\s+/)
                .find((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) ?? "";
        return head.split("/").pop() ?? head;
    });

/* DID THIS TOOL CALL GO LOOKING FOR CODE — what the pre-injection experiment is judged on, and a question the
 * category alone cannot answer.
 *
 * `toolCategoryOf` reads a tool's NAME, and this workspace's own search tool is a CLI: `iq q "…"` arrives as
 * Bash and categorizes as `execute`, next to every `grep`/`rg`/`find` the model runs by hand. Counting only the
 * `search` category would score retrieval against the searches it does not replace while missing every one it
 * does — precisely backwards on a sandbox with iq turned on. */
export const isSearchCall = (call: { readonly category: ToolKind; readonly target?: string | undefined }): boolean => {
    if (call.category === "search") {
        return true;
    }
    if (call.category !== "execute" || call.target === undefined) {
        return false;
    }
    return commandHeads(call.target).some((head) => SEARCH_COMMANDS.has(head));
};

/* DID THIS CALL REACH FILE CONTENT. Search counting and this transition are independent: one compound Bash
 * call can do both (`rg …; sed -n …`). The route counts that call's search as opening work first, then closes
 * orientation for later calls. That preserves the tool-call granularity of the ledger without losing the read
 * just because the same shell invocation also searched. */
export const isFileWorkCall = (call: { readonly category: ToolKind; readonly target?: string | undefined }): boolean => {
    if (call.category === "read" || call.category === "edit") {
        return true;
    }
    if (call.category !== "execute" || call.target === undefined) {
        return false;
    }
    return commandHeads(call.target).some((head) => FILE_WORK_COMMANDS.has(head));
};

/* If a compound shell call both searches and reaches a file, which happened first? The turn ledger counts tool
 * calls, but ordering inside one call still decides whether its search was orientation. A search-only native
 * tool is opening by definition; `cat file; rg term` is not, while `rg term; sed -n …` is. */
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

// The file path / command / query a tool acts on, for the tool_call frame's target (the raw mono string on
// the card). Key order matters: the most specific spelling wins. `element` is @playwright/mcp's own
// human-readable description of what a click/type/hover is aimed at ("Submit button") — the only thing those
// calls carry that means anything to a reader, since their `ref` is a snapshot-local handle like `e12`.
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
