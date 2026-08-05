import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { syncHookOutput } from "../testing.js";
import { browserArtifactHooks, browserOutputDir, screenshotImage } from "./browser-artifacts.js";

const OUTPUT = browserOutputDir("/work");

const hooks = browserArtifactHooks(OUTPUT);

const fire = async (toolName: string, toolInput: Record<string, unknown>) => {
    const [matcher] = hooks.PreToolUse!;
    // The matcher is a regex the harness applies to the tool name; the callback itself sees every call, so a
    // test that fires it directly has to honour the same gate or it proves nothing about what runs in a turn.
    if (!new RegExp(matcher!.matcher!).test(toolName)) {
        return {};
    }
    const input = { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, tool_use_id: "t1" } as unknown as HookInput;
    return matcher!.hooks[0]!(input, "t1", { signal: new AbortController().signal });
};

const rewritten = (result: Awaited<ReturnType<typeof fire>>): string | undefined =>
    (syncHookOutput(result).hookSpecificOutput as { updatedInput?: { filename?: string } } | undefined)?.updatedInput?.filename;

test("the output dir is the one place browser artifacts live", () => {
    expect(OUTPUT).toBe("/work/.intentic/browser/output");
});

// The whole point: a bare name resolves against the agent's cwd inside @playwright/mcp, which is the repo.
test("a model-named screenshot is redirected out of the agent's cwd", async () => {
    expect(rewritten(await fire("mcp__web__browser_take_screenshot", { filename: "tt-viewport.png", type: "png" }))).toBe(
        "/work/.intentic/browser/output/tt-viewport.png",
    );
});

test("the rest of the tool input rides along untouched", async () => {
    const result = await fire("mcp__web__browser_take_screenshot", { filename: "shot.png", type: "png", fullPage: true });
    expect((syncHookOutput(result).hookSpecificOutput as { updatedInput?: Record<string, unknown> }).updatedInput).toEqual({
        filename: "/work/.intentic/browser/output/shot.png",
        type: "png",
        fullPage: true,
    });
});

test("the agent is told the absolute path, since the tool answers with a relative one", async () => {
    const result = await fire("mcp__web__browser_take_screenshot", { filename: "shot.png" });
    expect((syncHookOutput(result).hookSpecificOutput as { additionalContext?: string }).additionalContext).toContain(
        "/work/.intentic/browser/output/shot.png",
    );
});

// A logged-in capability's browser gets no --output-dir at all, so its named files need this even more.
test("a capability's own browser is redirected too", async () => {
    expect(rewritten(await fire("mcp__reddit-main__browser_take_screenshot", { filename: "thread.png" }))).toBe(
        "/work/.intentic/browser/output/thread.png",
    );
});

test.each([
    ["../../escape.png", "/work/.intentic/browser/output/escape.png"],
    ["/etc/passwd.png", "/work/.intentic/browser/output/passwd.png"],
])("a name that would escape the output dir keeps only its basename: %s", async (filename, expected) => {
    expect(rewritten(await fire("mcp__web__browser_take_screenshot", { filename }))).toBe(expected);
});

// The agent asking for structure inside the output dir is a request about naming, not about placement.
test("a subdirectory the agent asked for is honoured inside the output dir", async () => {
    expect(rewritten(await fire("mcp__web__browser_take_screenshot", { filename: "before/nav.png" }))).toBe(
        "/work/.intentic/browser/output/before/nav.png",
    );
});

test("a name already resolved into the output dir is left as it is", async () => {
    expect(await fire("mcp__web__browser_take_screenshot", { filename: "/work/.intentic/browser/output/shot.png" })).toEqual({});
});

// Unnamed artifacts are the case --output-dir already owns; touching them would only fight the tool.
test("an unnamed screenshot is not touched", async () => {
    expect(await fire("mcp__web__browser_take_screenshot", { type: "png" })).toEqual({});
});

test.each(["mcp__web__browser_navigate", "Write", "mcp__web__browser_snapshot"])("%s is not a screenshot tool", async (toolName) => {
    expect(await fire(toolName, { filename: "shot.png" })).toEqual({});
});

/* The other direction: the tool's ANSWER back into a picture the chat can show. @playwright/mcp replies with a
 * markdown link relative to the agent's cwd, which for a repo cwd climbs out of the repo — useless to fetch
 * until it is put back into the workspace-root-relative route space. */
test("a screenshot's answer becomes a workspace path the chat can render", () => {
    const answer = "### Result\n- [Screenshot of viewport](../.intentic/browser/output/page-2026-07-30.png)\n";
    expect(screenshotImage(answer, "/work/myrepo", OUTPUT)).toEqual({ type: "image", path: ".intentic/browser/output/page-2026-07-30.png" });
});

test("a screenshot taken at the workspace root resolves the same way", () => {
    const answer = "- [Screenshot of viewport](.intentic/browser/output/shot.png)";
    expect(screenshotImage(answer, "/work", OUTPUT)).toEqual({ type: "image", path: ".intentic/browser/output/shot.png" });
});

// A link we can't place inside the output dir is a file this module never dictated — claiming it would put an
// arbitrary path from tool output in front of the user as "the screenshot".
test.each([
    ["a link outside the output dir", "- [Something](../src/index.ts)"],
    ["no link at all", "Took the screenshot."],
])("%s produces no picture", (_case, answer) => {
    expect(screenshotImage(answer, "/work/myrepo", OUTPUT)).toBeUndefined();
});
