import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { syncHookOutput } from "../testing.js";
import { type DiagRunner, editDiagnosticsHooks, type ModulesProbe } from "./agent-diagnostics.js";

const RESOLVABLE: ModulesProbe = async () => ({ kind: "installed", missing: [] });
const MISSING: ModulesProbe = async () => ({ kind: "absent" });
// A tree that exists and is behind — the state an agent leaves when it adds a dependency and does not install it.
const stale =
    (...missing: string[]): ModulesProbe =>
    async () => ({ kind: "installed", missing });

// Fire one edit at a hook set. Returned separately from runHook so a test can drive the SAME set twice and
// observe the per-turn state (the missing-dependency notice is told once, not stapled to every edit).
const fire = async (hooks: ReturnType<typeof editDiagnosticsHooks>, toolInput: unknown) => {
    const [matcher] = hooks.PostToolUse!;
    const input = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: toolInput, tool_use_id: "t1" } as unknown as HookInput;
    return matcher!.hooks[0]!(input, "t1", { signal: new AbortController().signal });
};

// Drive the PostToolUse hook directly with a fake lsp runner — no binary, no filesystem. Dependencies are
// present unless a test says otherwise, which is the case every pre-existing assertion assumes.
const runHook = async (diag: DiagRunner, toolInput: unknown, modules: ModulesProbe = RESOLVABLE) =>
    fire(editDiagnosticsHooks("/work", undefined, diag, modules), toolInput);

const checked =
    (...lines: string[]): DiagRunner =>
    async () => ({ kind: "checked", lines });

const withErrors: DiagRunner = checked(
    "src/app.ts:12:5: error TS2304: Cannot find name 'foo'.",
    "src/app.ts:14:1: warning TS6133: 'bar' is declared but never used.",
);

test("compile errors ride back as additionalContext; warnings are dropped", async () => {
    const result = await runHook(withErrors, { file_path: "/work/src/app.ts" });
    const context = (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string }).additionalContext;
    expect(context).toContain("error TS2304");
    expect(context).not.toContain("TS6133");
});

test("a clean file adds nothing", async () => {
    const result = await runHook(checked(), { file_path: "/work/src/app.ts" });
    expect(result).toEqual({});
});

test("non-TypeScript files are never checked", async () => {
    let ran = false;
    const result = await runHook(
        async () => {
            ran = true;
            return { kind: "checked", lines: [] };
        },
        { file_path: "/work/README.md" },
    );
    expect(result).toEqual({});
    expect(ran).toBe(false);
});

// undefined is "there is no answer to be had" — no tsconfig above the file, or no daemon we could reach — and
// must read the same as clean to the model rather than inventing a verdict.
test("an unanswerable check stays silent", async () => {
    const result = await runHook(async () => undefined, { file_path: "/work/src/app.ts" });
    expect(result).toEqual({});
});

test("a tool input without a file path stays silent", async () => {
    const result = await runHook(withErrors, { command: "echo hi" });
    expect(result).toEqual({});
});

// Without node_modules the compiler can't resolve ANY import — not even node: builtins, whose types ship in
// @types/node — so it reports errors on lines the edit never touched. Confident wrong feedback is worse than
// none: an agent transcript shows a turn spent reasoning its way to "every diagnostic was a false positive".
test("with no resolvable node_modules the type-check never runs", async () => {
    let ran = false;
    const result = await runHook(
        async () => {
            ran = true;
            return { kind: "checked", lines: ["src/app.ts:1:1: error TS2307: Cannot find module 'node:path'."] };
        },
        { file_path: "/work/src/app.ts" },
        MISSING,
    );
    expect(ran).toBe(false);
    expect((syncHookOutput(result).hookSpecificOutput as { additionalContext?: string }).additionalContext).toContain(
        "Type diagnostics are unavailable for this edit",
    );
});

/* The daemon refusing IS the fix for the worst failure in the logs: a worktree project whose config chain the
 * daemon cannot load fell back to ES5 defaults and reported Map, Promise and `node:` imports as broken on
 * every edit — thousands of confident, wrong errors injected into turns. The refusal must surface as the same
 * once-per-turn unavailability sentence, never as diagnostics. */
test("a daemon refusal is told once as unavailability, not injected as errors", async () => {
    const hooks = editDiagnosticsHooks("/work", undefined, async () => ({ kind: "unavailable" }), RESOLVABLE);
    const first = await fire(hooks, { file_path: "/work/src/a.ts" });
    expect((syncHookOutput(first).hookSpecificOutput as { additionalContext?: string }).additionalContext).toContain(
        "Type diagnostics are unavailable for this edit",
    );
    const second = await fire(hooks, { file_path: "/work/src/b.ts" });
    expect(second).toEqual({});
});

test("the missing-dependency reason is told ONCE per turn, not stapled to every edit", async () => {
    const hooks = editDiagnosticsHooks("/work", undefined, withErrors, MISSING);
    const first = await fire(hooks, { file_path: "/work/src/a.ts" });
    const second = await fire(hooks, { file_path: "/work/src/b.ts" });
    expect((syncHookOutput(first).hookSpecificOutput as { additionalContext?: string }).additionalContext).toContain(
        "Type diagnostics are unavailable for this edit",
    );
    expect(second).toEqual({});
});

const contextOf = (result: HookJSONOutput): string =>
    (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string }).additionalContext ?? "";

/* A PARTIALLY installed tree is the case the old boolean gate could not see: node_modules exists, so it opened,
 * and the one package the agent just added is still missing. The diagnostics are real and must survive — only
 * the reading of the unresolved-import ones is wrong without this sentence. */
test("a tree missing one package still type-checks, with the cause named alongside the errors", async () => {
    let ran = false;
    const result = await runHook(
        async () => {
            ran = true;
            return { kind: "checked", lines: ["src/app.ts:1:1: error TS2307: Cannot find module 'left-pad'."] };
        },
        { file_path: "/work/src/app.ts" },
        stale("left-pad"),
    );
    expect(ran).toBe(true);
    const context = contextOf(result);
    expect(context).toContain("error TS2307");
    expect(context).toContain("1 dependency that is not installed (left-pad)");
    expect(context).toContain("the install being behind");
    expect(context).toContain("do not run an install");
});

test("a drifted tree is worth saying even when the edit itself type-checks clean — the next test will fail too", async () => {
    const result = await runHook(checked(), { file_path: "/work/src/app.ts" }, stale("vue", "zod"));
    expect(contextOf(result)).toContain("2 dependencies that are not installed (vue, zod)");
});

test("the drift sentence is told once per package, and again when the set of missing names changes", async () => {
    const missing = ["vue"];
    const hooks = editDiagnosticsHooks("/work", undefined, withErrors, async () => ({ kind: "installed", missing: [...missing] }));
    expect(contextOf(await fire(hooks, { file_path: "/work/src/a.ts" }))).toContain("(vue)");
    // Same names, same package: the model has the reason already.
    expect(contextOf(await fire(hooks, { file_path: "/work/src/b.ts" }))).not.toContain("not installed");
    // A half-finished install changed the answer, so it is worth saying again.
    missing.push("zod");
    expect(contextOf(await fire(hooks, { file_path: "/work/src/c.ts" }))).toContain("(vue, zod)");
});

test("a fully installed tree says nothing extra — the diagnostics stand on their own", async () => {
    expect(contextOf(await runHook(withErrors, { file_path: "/work/src/app.ts" }))).not.toContain("not installed");
});
