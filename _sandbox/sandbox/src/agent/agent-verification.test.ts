import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test } from "vitest";
import { syncHookOutput } from "../testing.js";
import { classifyCommand, createVerificationLedger, type ScriptsProbe, verificationHooks } from "./agent-verification.js";

const SCRIPTS: ScriptsProbe = async () => ["test", "lint", "dev"];
const NO_PACKAGE: ScriptsProbe = async () => undefined;

// Drive a hook set the way the SDK does. Each helper fires one event at the set built for a single turn, so a
// test can interleave edits, commands and stops against ONE ledger — which is the whole thing under test.
const edit = async (hooks: ReturnType<typeof verificationHooks>, file_path: string) => {
    const matcher = hooks.PostToolUse![0]!;
    const input = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path }, tool_use_id: "t" } as unknown as HookInput;
    return matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
};

const bash = async (hooks: ReturnType<typeof verificationHooks>, command: string, response: string) => {
    const matcher = hooks.PostToolUse![1]!;
    const input = { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command }, tool_response: response, tool_use_id: "t" } as unknown as HookInput;
    return matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
};

const bashFailed = async (hooks: ReturnType<typeof verificationHooks>, command: string, error: string) => {
    const matcher = hooks.PostToolUseFailure![0]!;
    const input = { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, error, tool_use_id: "t" } as unknown as HookInput;
    return matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
};

const stop = async (hooks: ReturnType<typeof verificationHooks>, stop_hook_active = false) => {
    const matcher = hooks.Stop![0]!;
    const input = { hook_event_name: "Stop", stop_hook_active } as unknown as HookInput;
    const result = await matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
    return (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
};

const PASSED = "all good\n--- [exit 0, 2s] 40 lines filtered to 12\n";
const FAILED = "1 failed\n--- [exit 1, 2s] 40 lines filtered to 12\n";

describe("command classification", () => {
    test.each([
        ["pnpm test", "test"],
        ["pnpm -C _sandbox/workspace-ignore test", "test"],
        ["./node_modules/.bin/vitest run src/a.test.ts", "test"],
        ["CI=1 npx vitest run", "test"],
        ["./node_modules/.bin/tsgo --noEmit -p tsconfig.json", "typecheck"],
        ["pnpm oxlint --deny-warnings", "lint"],
        ["cargo test", "test"],
        ["go build ./...", "build"],
        ["cd _editor/web && pnpm typecheck", "typecheck"],
    ])("%s proves %s", (command, kind) => {
        expect(command.split(/(?:&&|\|\||;|\|)/).map(classifyCommand).find((k) => k !== undefined)).toBe(kind);
    });

    test.each(["ls -la", "git status", "cat package.json", "echo test", "rm -rf dist"])("%s proves nothing", (command) => {
        expect(classifyCommand(command)).toBeUndefined();
    });

    // `echo test` must not read as a test run just because the word appears — the classifier keys on the
    // command position, not on a substring anywhere in the line.
    test("a check named only as an argument is not evidence", () => {
        expect(classifyCommand("echo test")).toBeUndefined();
        expect(classifyCommand("git commit -m 'add test'")).toBeUndefined();
    });
});

describe("the ledger", () => {
    test("a passing check after the last edit clears the verdict", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit("/work/src/a.ts");
        ledger.noteCommand("pnpm test", true, "");
        expect(ledger.verdict()).toBeUndefined();
    });

    // The ordering case the counter exists for: verifying and THEN editing leaves the edits unproven.
    test("a passing check BEFORE the last edit does not", () => {
        const ledger = createVerificationLedger();
        ledger.noteCommand("pnpm test", true, "");
        ledger.noteEdit("/work/src/a.ts");
        expect(ledger.verdict()?.paths).toEqual(["/work/src/a.ts"]);
    });

    test("a failing check is reported as the reason, distinct from never having checked", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit("/work/src/a.ts");
        ledger.noteCommand("pnpm test", false, "2 failed");
        const verdict = ledger.verdict();
        expect(verdict?.failed?.command).toBe("pnpm test");
        expect(verdict?.failed?.detail).toBe("2 failed");
    });

    test("editing only prose is not something a check can speak to", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit("/work/README.md");
        ledger.noteEdit("/work/CHANGELOG");
        expect(ledger.verdict()).toBeUndefined();
    });

    test("a prose edit alongside a code edit still needs proof", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit("/work/README.md");
        ledger.noteEdit("/work/src/a.ts");
        expect(ledger.verdict()?.paths).toEqual(["/work/src/a.ts"]);
    });

    test("the same file edited repeatedly is named once", () => {
        const ledger = createVerificationLedger();
        ledger.noteEdit("/work/src/a.ts");
        ledger.noteEdit("/work/src/a.ts");
        expect(ledger.verdict()?.paths).toEqual(["/work/src/a.ts"]);
    });

    test("a turn that edited nothing never asks for anything", () => {
        const ledger = createVerificationLedger();
        ledger.noteCommand("pnpm test", false, "broken");
        expect(ledger.verdict()).toBeUndefined();
    });
});

describe("the stop nudge", () => {
    test("edited code with no check is asked to run the workspace's own script", async () => {
        const hooks = verificationHooks(undefined, SCRIPTS);
        await edit(hooks, "/work/src/a.ts");
        const nudge = await stop(hooks);
        expect(nudge).toContain("/work/src/a.ts");
        expect(nudge).toContain("`pnpm test`");
        expect(nudge).toContain("`pnpm lint`");
        // `dev` is a script but not a check — offering it would be worse than offering nothing.
        expect(nudge).not.toContain("pnpm dev");
    });

    test("a passing check means the turn ends silently", async () => {
        const hooks = verificationHooks(undefined, SCRIPTS);
        await edit(hooks, "/work/src/a.ts");
        await bash(hooks, "pnpm test", PASSED);
        expect(await stop(hooks)).toBeUndefined();
    });

    test("a non-zero exit in the footer is not a pass", async () => {
        const hooks = verificationHooks(undefined, SCRIPTS);
        await edit(hooks, "/work/src/a.ts");
        await bash(hooks, "pnpm test", FAILED);
        expect(await stop(hooks)).toContain("did NOT pass");
    });

    test("a Bash tool failure counts as a failed check", async () => {
        const hooks = verificationHooks(undefined, SCRIPTS);
        await edit(hooks, "/work/src/a.ts");
        await bashFailed(hooks, "pnpm test", "exit 1: 2 failed");
        const nudge = await stop(hooks);
        expect(nudge).toContain("2 failed");
    });

    test("a workspace with no package.json is told to pick its own check, not given an invented one", async () => {
        const hooks = verificationHooks(undefined, NO_PACKAGE);
        await edit(hooks, "/srv/thing.py");
        const nudge = await stop(hooks);
        expect(nudge).toContain("defines no test/lint/typecheck script");
        expect(nudge).not.toContain("pnpm");
    });

    test("at most two asks per turn — the third stop is silent", async () => {
        const hooks = verificationHooks(undefined, SCRIPTS);
        await edit(hooks, "/work/src/a.ts");
        expect(await stop(hooks)).toBeDefined();
        expect(await stop(hooks)).toBeDefined();
        expect(await stop(hooks)).toBeUndefined();
    });

    test("the SDK's own re-entry flag suppresses the ask on its own", async () => {
        const hooks = verificationHooks(undefined, SCRIPTS);
        await edit(hooks, "/work/src/a.ts");
        expect(await stop(hooks, true)).toBeUndefined();
    });

    test("a check that fixes the failure clears the second stop", async () => {
        const hooks = verificationHooks(undefined, SCRIPTS);
        await edit(hooks, "/work/src/a.ts");
        await bash(hooks, "pnpm test", FAILED);
        expect(await stop(hooks)).toContain("did NOT pass");
        await edit(hooks, "/work/src/a.ts");
        await bash(hooks, "pnpm test", PASSED);
        expect(await stop(hooks)).toBeUndefined();
    });
});
