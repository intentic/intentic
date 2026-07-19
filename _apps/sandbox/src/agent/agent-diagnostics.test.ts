import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import { type DiagRunner, editDiagnosticsHooks } from "./agent-diagnostics.js";

// Drive the PostToolUse hook directly with a fake lsp runner — no binary, no filesystem.
const runHook = async (diag: DiagRunner, toolInput: unknown) => {
    const hooks = editDiagnosticsHooks("/work", diag);
    const [matcher] = hooks.PostToolUse!;
    const input = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: toolInput, tool_use_id: "t1" } as unknown as HookInput;
    return matcher!.hooks[0]!(input, "t1", { signal: new AbortController().signal });
};

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
