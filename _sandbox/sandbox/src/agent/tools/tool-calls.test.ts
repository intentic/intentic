import { WORKSPACE_ROOT } from "@intentic/constants";
import { homedir } from "node:os";
import { browserOutputDir } from "../../browser/cast/browser-artifacts.js";
import { editDiffContent, mayShowPicture, resultContent, toolLocations } from "./tool-calls.js";

const CWD = WORKSPACE_ROOT;
const OUTPUT = browserOutputDir(WORKSPACE_ROOT);

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

// A `~/.claude/...` path looks like an escape and is not: those stores are symlinked onto the workspace volume, so the
// CLI's plan is an ordinary workspace file the card can open.
test("toolLocations resolves the SDK's own stores onto the workspace they are linked into", () => {
    expect(toolLocations({ file_path: `${homedir()}/.claude/plans/wiggly-spring.md` }, CWD)).toEqual([
        { path: ".intentic/records/sessions/claude/plans/wiggly-spring.md" },
    ]);
    // Not every ~/.claude entry is linked: skills and settings are image-baked and container-local.
    expect(toolLocations({ file_path: `${homedir()}/.claude/skills/iq/SKILL.md` }, CWD)).toBeUndefined();
    expect(toolLocations({ file_path: `${homedir()}/.claude/settings.json` }, CWD)).toBeUndefined();
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
    // OpenCode 2 names the file `path`.
    expect(editDiffContent("Edit", { path: "c.ts", oldString: "p", newString: "q" }, CWD)).toEqual({ type: "diff", path: "c.ts", oldText: "p", newText: "q" });
    expect(editDiffContent("Write", { path: "d.ts", content: "new" }, CWD)).toEqual({ type: "diff", path: "d.ts", newText: "new" });
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

test("editDiffContent degrades to undefined on unrecognized shapes: never throws", () => {
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

// A Read of an image answers with the picture as a block, which the text flattening can only call `[image]`.
const IMAGE_BLOCK = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } };

test("mayShowPicture names the two calls whose answer can be a picture", () => {
    expect(
        ["Read", "mcp__web__browser_take_screenshot", "mcp__reddit-main__browser_take_screenshot", "Bash", "mcp__web__browser_snapshot"].map(
            mayShowPicture,
        ),
    ).toEqual([true, true, true, false, false]);
});

test("a Read that answered with an image carries the file it read, and no `[image]` placeholder", () => {
    const call = { name: "Read", input: { file_path: `${WORKSPACE_ROOT}/.intentic/records/artifacts/browser/after.png` } };
    expect(resultContent([IMAGE_BLOCK], CWD, OUTPUT, call)).toEqual([{ type: "image", path: ".intentic/records/artifacts/browser/after.png" }]);
});

test("a Read that answered with text stays text, whatever the file is called", () => {
    const call = { name: "Read", input: { file_path: `${WORKSPACE_ROOT}/logo.svg` } };
    expect(resultContent("<svg/>", CWD, OUTPUT, call)).toEqual([{ type: "text", text: "<svg/>" }]);
});

test("a Read of an image outside the workspace has no path the chat could fetch, so it stays text", () => {
    const call = { name: "Read", input: { file_path: "/tmp/shots/after.png" } };
    expect(resultContent([IMAGE_BLOCK], CWD, OUTPUT, call)).toEqual([{ type: "text", text: "[image]" }]);
});

test("a screenshot's answer keeps its words and gains the file they name", () => {
    const answer = "### Result\n- [Screenshot of viewport](.intentic/records/artifacts/browser/shot.png)";
    expect(
        resultContent([{ type: "text", text: answer }, IMAGE_BLOCK], CWD, OUTPUT, { name: "mcp__web__browser_take_screenshot", input: {} }),
    ).toEqual([
        { type: "text", text: answer },
        { type: "image", path: ".intentic/records/artifacts/browser/shot.png" },
    ]);
});

test("with no remembered call (a failure, or a call that cannot show a picture) the answer is its flattened text", () => {
    expect(resultContent([IMAGE_BLOCK], CWD, OUTPUT, undefined)).toEqual([{ type: "text", text: "[image]" }]);
});
