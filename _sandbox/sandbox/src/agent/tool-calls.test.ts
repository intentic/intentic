import { WORKSPACE_ROOT } from "@intentic/constants";
import { expect, test } from "vitest";
import {
    displayNameOf,
    editDiffContent,
    isFileWorkCall,
    isSearchCall,
    searchPrecedesFileWork,
    toolCategoryOf,
    toolLocations,
    toolTarget,
} from "./tool-calls.js";

const CWD = WORKSPACE_ROOT;

test("displayNameOf maps OpenCode's lowercase ids and passes Claude names through", () => {
    expect(displayNameOf("bash")).toBe("Bash");
    expect(displayNameOf("patch")).toBe("Edit");
    expect(displayNameOf("list")).toBe("LS");
    expect(displayNameOf("Edit")).toBe("Edit");
    expect(displayNameOf("mystery")).toBe("mystery");
});

test("toolCategoryOf categorizes builtin names case-insensitively", () => {
    expect(toolCategoryOf("Read")).toBe("read");
    expect(toolCategoryOf("Edit")).toBe("edit");
    expect(toolCategoryOf("Write")).toBe("edit");
    expect(toolCategoryOf("Bash")).toBe("execute");
    expect(toolCategoryOf("Grep")).toBe("search");
    expect(toolCategoryOf("WebFetch")).toBe("fetch");
    expect(toolCategoryOf("websearch")).toBe("search");
    expect(toolCategoryOf("Task")).toBe("other");
    expect(toolCategoryOf("mystery")).toBe("other");
});

/* THE CATEGORY ALONE CANNOT ANSWER "was this a search", and the pre-injection experiment is judged on the
 * answer. This workspace's own search tool is a CLI — `iq q "…"` is Bash, which categorizes as `execute` — so
 * counting the `search` category would miss every search on a sandbox with iq switched on, which is the sandbox
 * the retrieval is being measured against. */
test("isSearchCall counts the CLI searches the category misses, and leaves shell plumbing alone", () => {
    expect(isSearchCall({ category: "search", target: "createServer" })).toBe(true);
    expect(isSearchCall({ category: "execute", target: `iq q "where is the floor enforced"` })).toBe(true);
    // Past a `cd`, and past a path: the statement that matters is rarely the first word of the command.
    expect(isSearchCall({ category: "execute", target: `cd /work/intentic && iq def createIgnoreScope` })).toBe(true);
    expect(isSearchCall({ category: "execute", target: `/usr/bin/rg -n "TODO" src` })).toBe(true);
    expect(isSearchCall({ category: "execute", target: `RG_FLAGS=x grep -rn needle .` })).toBe(true);
    // A command that greps its OWN output is shell plumbing, not the model looking for code.
    expect(isSearchCall({ category: "execute", target: `git log --oneline | grep fix` })).toBe(false);
    expect(isSearchCall({ category: "execute", target: `pnpm test` })).toBe(false);
    // A tool with no command to read — a browser click is `execute` too.
    expect(isSearchCall({ category: "execute" })).toBe(false);
    expect(isSearchCall({ category: "read", target: "src/index.ts" })).toBe(false);
});

test("isFileWorkCall recognizes direct shell reads but not output-truncation pipes", () => {
    expect(isFileWorkCall({ category: "read", target: "src/index.ts" })).toBe(true);
    expect(isFileWorkCall({ category: "edit", target: "src/index.ts" })).toBe(true);
    expect(isFileWorkCall({ category: "execute", target: "sed -n '1,80p' src/index.ts" })).toBe(true);
    expect(isFileWorkCall({ category: "execute", target: "cd repo && /usr/bin/cat src/index.ts" })).toBe(true);
    expect(isFileWorkCall({ category: "execute", target: "rg needle src | head -20" })).toBe(false);
    expect(isFileWorkCall({ category: "execute", target: "git log | sed -n '1,20p'" })).toBe(false);
    // A compound call can both search and reach a file; callers must not make the classifications exclusive.
    const compound = { category: "execute" as const, target: "rg needle src; sed -n '1,80p' src/index.ts" };
    expect(isSearchCall(compound)).toBe(true);
    expect(isFileWorkCall(compound)).toBe(true);
    expect(searchPrecedesFileWork(compound)).toBe(true);
    expect(searchPrecedesFileWork({ category: "execute", target: "cat src/index.ts; rg needle src" })).toBe(false);
});

test("toolCategoryOf categorizes MCP names by their tool segment's trailing verb", () => {
    expect(toolCategoryOf("mcp__hashline__hashline_edit")).toBe("edit");
    expect(toolCategoryOf("mcp__docs__page_read")).toBe("read");
    expect(toolCategoryOf("obs.search")).toBe("search");
    expect(toolCategoryOf("mcp__voice__join_call")).toBe("other");
});

// Every browser tool used to fall through the suffix rule to "other" and draw the generic cog — a turn spent
// clicking through the user's own app read as a column of identical grey rows.
test("browser tools read as going somewhere, doing something, or looking at the result", () => {
    expect(displayNameOf("mcp__web__browser_navigate")).toBe("Browser navigate");
    expect(displayNameOf("mcp__reddit__browser_click")).toBe("Browser click");
    expect(displayNameOf("mcp__web__browser_take_screenshot")).toBe("Browser screenshot");
    expect(displayNameOf("mcp__web__browser_navigate_back")).toBe("Browser navigate back");

    expect(toolCategoryOf("mcp__web__browser_navigate")).toBe("fetch");
    expect(toolCategoryOf("mcp__web__browser_snapshot")).toBe("read");
    expect(toolCategoryOf("mcp__web__browser_take_screenshot")).toBe("read");
    expect(toolCategoryOf("mcp__reddit__browser_click")).toBe("execute");
    // Unlisted verbs are acts on the page, not unknowns.
    expect(toolCategoryOf("mcp__web__browser_fill_form")).toBe("execute");
});

test("toolTarget picks the most specific key across both spelling families", () => {
    expect(toolTarget({ file_path: "/work/a.ts" })).toBe("/work/a.ts");
    expect(toolTarget({ filePath: "/work/a.ts" })).toBe("/work/a.ts");
    expect(toolTarget({ command: "ls -la" })).toBe("ls -la");
    expect(toolTarget({ pattern: "TODO" })).toBe("TODO");
    expect(toolTarget({ url: "https://x.dev" })).toBe("https://x.dev");
    // What a browser click/type is aimed at, in @playwright/mcp's own words — its `ref` ("e12") says nothing.
    expect(toolTarget({ element: "Submit button", ref: "e12" })).toBe("Submit button");
    expect(toolTarget({ query: "how" })).toBe("how");
    expect(toolTarget({ file_path: "/work/a.ts", command: "ignored" })).toBe("/work/a.ts");
    expect(toolTarget("nope")).toBeUndefined();
    expect(toolTarget({})).toBeUndefined();
});

test("toolLocations relativizes absolute paths onto the route space and keeps relative ones", () => {
    expect(toolLocations({ file_path: "/work/app/src/a.ts" }, CWD)).toEqual([{ path: "app/src/a.ts" }]);
    expect(toolLocations({ filePath: "docs/readme.md" }, CWD)).toEqual([{ path: "docs/readme.md" }]);
});

test("toolLocations carries Read's 1-based offset as the line", () => {
    expect(toolLocations({ file_path: "/work/a.ts", offset: 42 }, CWD)).toEqual([{ path: "a.ts", line: 42 }]);
    expect(toolLocations({ file_path: "/work/a.ts", offset: 0 }, CWD)).toEqual([{ path: "a.ts" }]);
});

test("toolLocations omits paths escaping the workspace (the routes can't address them)", () => {
    expect(toolLocations({ file_path: "/etc/passwd" }, CWD)).toBeUndefined();
    expect(toolLocations({ file_path: "../outside.ts" }, CWD)).toBeUndefined();
    expect(toolLocations({ command: "ls" }, CWD)).toBeUndefined();
});

test("editDiffContent derives an Edit diff from either spelling family", () => {
    expect(editDiffContent("Edit", { file_path: "/work/a.ts", old_string: "foo", new_string: "bar" }, CWD)).toEqual({
        type: "diff",
        path: "a.ts",
        oldText: "foo",
        newText: "bar",
    });
    expect(editDiffContent("Edit", { filePath: "b.ts", oldString: "x", newString: "y" }, CWD)).toEqual({
        type: "diff",
        path: "b.ts",
        oldText: "x",
        newText: "y",
    });
});

test("editDiffContent derives a whole-file diff (no oldText) from Write and NotebookEdit", () => {
    expect(editDiffContent("Write", { file_path: "/work/new.ts", content: "hello" }, CWD)).toEqual({
        type: "diff",
        path: "new.ts",
        newText: "hello",
    });
    expect(editDiffContent("NotebookEdit", { notebook_path: "/work/n.ipynb", new_source: "cell" }, CWD)).toEqual({
        type: "diff",
        path: "n.ipynb",
        newText: "cell",
    });
});

test("editDiffContent caps oversized sides and flags truncation", () => {
    const big = "x".repeat(40_000);
    const diff = editDiffContent("Write", { file_path: `${WORKSPACE_ROOT}/big.txt`, content: big }, CWD);
    expect(diff?.type).toBe("diff");
    if (diff?.type === "diff") {
        expect(diff.newText.length).toBe(32_000);
        expect(diff.truncated).toBe(true);
    }
});

test("editDiffContent degrades to undefined on unrecognized shapes — never throws", () => {
    expect(editDiffContent("Edit", { file_path: "/work/a.ts" }, CWD)).toBeUndefined();
    expect(editDiffContent("MultiEdit", { file_path: "/work/a.ts", edits: [] }, CWD)).toBeUndefined();
    expect(editDiffContent("Bash", { command: "ls" }, CWD)).toBeUndefined();
    expect(editDiffContent("Write", null, CWD)).toBeUndefined();
});

test("editDiffContent keeps a workspace-escaping path for display (locations enforce the route space, not diffs)", () => {
    expect(editDiffContent("Write", { file_path: "/tmp/out.txt", content: "x" }, CWD)).toEqual({
        type: "diff",
        path: "/tmp/out.txt",
        newText: "x",
    });
});
