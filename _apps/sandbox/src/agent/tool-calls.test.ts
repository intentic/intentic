import { expect, test } from "vitest";
import { displayNameOf, editDiffContent, toolCategoryOf, toolLocations, toolTarget } from "./tool-calls.js";

const CWD = "/work";

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

test("toolCategoryOf categorizes MCP names by their tool segment's trailing verb", () => {
    expect(toolCategoryOf("mcp__hashline__hashline_edit")).toBe("edit");
    expect(toolCategoryOf("mcp__docs__page_read")).toBe("read");
    expect(toolCategoryOf("obs.search")).toBe("search");
    expect(toolCategoryOf("mcp__voice__join_call")).toBe("other");
});

test("toolTarget picks the most specific key across both spelling families", () => {
    expect(toolTarget({ file_path: "/work/a.ts" })).toBe("/work/a.ts");
    expect(toolTarget({ filePath: "/work/a.ts" })).toBe("/work/a.ts");
    expect(toolTarget({ command: "ls -la" })).toBe("ls -la");
    expect(toolTarget({ pattern: "TODO" })).toBe("TODO");
    expect(toolTarget({ url: "https://x.dev" })).toBe("https://x.dev");
    expect(toolTarget({ query: "how" })).toBe("how");
    expect(toolTarget({ file_path: "/work/a.ts", command: "ignored" })).toBe("/work/a.ts");
    expect(toolTarget("nope")).toBeUndefined();
    expect(toolTarget({})).toBeUndefined();
});

test("toolLocations relativizes absolute paths onto the route space and keeps relative ones", () => {
    expect(toolLocations({ file_path: "/work/repositories/app/src/a.ts" }, CWD)).toEqual([{ path: "repositories/app/src/a.ts" }]);
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
    const diff = editDiffContent("Write", { file_path: "/work/big.txt", content: big }, CWD);
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
