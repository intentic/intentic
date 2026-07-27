import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { type DiagRunner, editDiagnosticsHooks, type ModulesProbe } from "./agent-diagnostics.js";

const RESOLVABLE: ModulesProbe = async () => true;
const MISSING: ModulesProbe = async () => false;

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
    fire(editDiagnosticsHooks("/work", diag, modules), toolInput);

const withErrors: DiagRunner = async () =>
    "src/app.ts:12:5: error TS2304: Cannot find name 'foo'.\nsrc/app.ts:14:1: warning TS6133: 'bar' is declared but never used.\n";

test("compile errors ride back as additionalContext; warnings are dropped", async () => {
    const result = await runHook(withErrors, { file_path: "/work/src/app.ts" });
    const context = (result.hookSpecificOutput as { additionalContext?: string }).additionalContext;
    expect(context).toContain("error TS2304");
    expect(context).not.toContain("TS6133");
});

test("a clean file adds nothing", async () => {
    const result = await runHook(async () => "no diagnostics\n", { file_path: "/work/src/app.ts" });
    expect(result).toEqual({});
});

test("non-TypeScript files are never checked", async () => {
    let ran = false;
    const result = await runHook(
        async () => {
            ran = true;
            return "no diagnostics\n";
        },
        { file_path: "/work/README.md" },
    );
    expect(result).toEqual({});
    expect(ran).toBe(false);
});

test("a failed lsp run (missing binary, crash, timeout) stays silent", async () => {
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
            return "src/app.ts:1:1: error TS2307: Cannot find module 'node:path'.\n";
        },
        { file_path: "/work/src/app.ts" },
        MISSING,
    );
    expect(ran).toBe(false);
    expect((result.hookSpecificOutput as { additionalContext?: string }).additionalContext).toContain("dependencies are not installed");
});

test("the missing-dependency reason is told ONCE per turn, not stapled to every edit", async () => {
    const hooks = editDiagnosticsHooks("/work", withErrors, MISSING);
    const first = await fire(hooks, { file_path: "/work/src/a.ts" });
    const second = await fire(hooks, { file_path: "/work/src/b.ts" });
    expect((first.hookSpecificOutput as { additionalContext?: string }).additionalContext).toContain("dependencies are not installed");
    expect(second).toEqual({});
});
