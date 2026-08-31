import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import type { IsolationPlan, TurnPlacement } from "../agents/isolation.js";
import { syncHookOutput } from "../testing.js";
import { type DiagRequest, type DiagRunner, editDiagnosticsHooks, type ModulesProbe } from "./agent-diagnostics.js";

const PLAN: IsolationPlan = {
    worktree: `${HISTORY_ROOT}/worktrees/c1`,
    root: WORKSPACE_ROOT,
    mirrors: ["intentic/node_modules"],
    overlays: `${HISTORY_ROOT}/overlays/c1`,
};
// A turn that got its namespace, which is the ordinary case wherever the container can build one.
const ANCHORED: TurnPlacement = { plan: PLAN, anchor: { pid: 4321, cwd: WORKSPACE_ROOT, plan: PLAN, dispose: () => {} } };
// A turn that is isolated but unenforced: no CAP_SYS_ADMIN, so the worktree stands on its own paths.
const UNANCHORED: TurnPlacement = { plan: PLAN };

const RESOLVABLE: ModulesProbe = async () => ({ kind: "installed", missing: [] });
const MISSING: ModulesProbe = async () => ({ kind: "absent" });
// A tree that exists and is behind: the state an agent leaves when it adds a dependency and does not install it.
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

// Drive the PostToolUse hook directly with a fake lsp runner: no binary, no filesystem. Dependencies are
// present unless a test says otherwise, which is the case every pre-existing assertion assumes.
const runHook = async (diag: DiagRunner, toolInput: unknown, modules: ModulesProbe = RESOLVABLE) =>
    fire(editDiagnosticsHooks(undefined, diag, modules), toolInput);

const checked =
    (...lines: string[]): DiagRunner =>
    async () => ({ kind: "checked", lines });

const withErrors: DiagRunner = checked(
    "src/app.ts:12:5: error TS2304: Cannot find name 'foo'.",
    "src/app.ts:14:1: warning TS6133: 'bar' is declared but never used.",
);

test("compile errors ride back as additionalContext; warnings are dropped", async () => {
    const result = await runHook(withErrors, { file_path: `${WORKSPACE_ROOT}/src/app.ts` });
    const context = (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string }).additionalContext;
    expect(context).toContain("error TS2304");
    expect(context).not.toContain("TS6133");
});

test("a clean file adds nothing", async () => {
    const result = await runHook(checked(), { file_path: `${WORKSPACE_ROOT}/src/app.ts` });
    expect(result).toEqual({});
});

test("non-TypeScript files are never checked", async () => {
    let ran = false;
    const result = await runHook(
        async () => {
            ran = true;
            return { kind: "checked", lines: [] };
        },
        { file_path: `${WORKSPACE_ROOT}/README.md` },
    );
    expect(result).toEqual({});
    expect(ran).toBe(false);
});

// undefined is "there is no answer to be had": no tsconfig above the file, so no project to check, and
// must read the same as clean to the model rather than inventing a verdict.
test("an unanswerable check stays silent", async () => {
    const result = await runHook(async () => undefined, { file_path: `${WORKSPACE_ROOT}/src/app.ts` });
    expect(result).toEqual({});
});

test("a tool input without a file path stays silent", async () => {
    const result = await runHook(withErrors, { command: "echo hi" });
    expect(result).toEqual({});
});

// Without node_modules the compiler can't resolve ANY import, not even node: builtins, whose types ship in
// @types/node, so it reports errors on lines the edit never touched. Confident wrong feedback is worse than
// none: an agent transcript shows a turn spent reasoning its way to "every diagnostic was a false positive".
test("with no resolvable node_modules the type-check never runs", async () => {
    let ran = false;
    const result = await runHook(
        async () => {
            ran = true;
            return { kind: "checked", lines: ["src/app.ts:1:1: error TS2307: Cannot find module 'node:path'."] };
        },
        { file_path: `${WORKSPACE_ROOT}/src/app.ts` },
        MISSING,
    );
    expect(ran).toBe(false);
    expect((syncHookOutput(result).hookSpecificOutput as { additionalContext?: string }).additionalContext).toContain(
        "Type diagnostics are unavailable for this edit",
    );
});

/* The checker refusing IS the fix for the worst failure in the logs: a worktree project whose config chain the
 * checker cannot load fell back to ES5 defaults and reported Map, Promise and `node:` imports as broken on
 * every edit: thousands of confident, wrong errors injected into turns. The refusal must surface as the same
 * once-per-turn unavailability sentence, never as diagnostics. */
test("a checker refusal is told once as unavailability, not injected as errors", async () => {
    const hooks = editDiagnosticsHooks(undefined, async () => ({ kind: "unavailable" }), RESOLVABLE);
    const first = await fire(hooks, { file_path: `${WORKSPACE_ROOT}/src/a.ts` });
    expect((syncHookOutput(first).hookSpecificOutput as { additionalContext?: string }).additionalContext).toContain(
        "Type diagnostics are unavailable for this edit",
    );
    const second = await fire(hooks, { file_path: `${WORKSPACE_ROOT}/src/b.ts` });
    expect(second).toEqual({});
});

test("the missing-dependency reason is told ONCE per turn, not stapled to every edit", async () => {
    const hooks = editDiagnosticsHooks(undefined, withErrors, MISSING);
    const first = await fire(hooks, { file_path: `${WORKSPACE_ROOT}/src/a.ts` });
    const second = await fire(hooks, { file_path: `${WORKSPACE_ROOT}/src/b.ts` });
    expect((syncHookOutput(first).hookSpecificOutput as { additionalContext?: string }).additionalContext).toContain(
        "Type diagnostics are unavailable for this edit",
    );
    expect(second).toEqual({});
});

const contextOf = (result: HookJSONOutput): string =>
    (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string }).additionalContext ?? "";

/* A PARTIALLY installed tree is the case the old boolean gate could not see: node_modules exists, so it opened,
 * and the one package the agent just added is still missing. The diagnostics are real and must survive: only
 * the reading of the unresolved-import ones is wrong without this sentence. */
test("a tree missing one package still type-checks, with the cause named alongside the errors", async () => {
    let ran = false;
    const result = await runHook(
        async () => {
            ran = true;
            return { kind: "checked", lines: ["src/app.ts:1:1: error TS2307: Cannot find module 'left-pad'."] };
        },
        { file_path: `${WORKSPACE_ROOT}/src/app.ts` },
        stale("left-pad"),
    );
    expect(ran).toBe(true);
    const context = contextOf(result);
    expect(context).toContain("error TS2307");
    expect(context).toContain("left-pad");
    expect(context).not.toContain("vue");
});

test("a drifted tree is worth saying even when the edit itself type-checks clean: the next test will fail too", async () => {
    const result = await runHook(checked(), { file_path: `${WORKSPACE_ROOT}/src/app.ts` }, stale("vue", "zod"));
    expect(contextOf(result)).toContain("vue");
    expect(contextOf(result)).toContain("zod");
});

test("the drift sentence is told once per package, and again when the set of missing names changes", async () => {
    const missing = ["vue"];
    const hooks = editDiagnosticsHooks(undefined, withErrors, async () => ({ kind: "installed", missing: [...missing] }));
    expect(contextOf(await fire(hooks, { file_path: "/work/src/a.ts" }))).toContain("(vue)");
    // Same names, same package: the model has the reason already.
    expect(contextOf(await fire(hooks, { file_path: "/work/src/b.ts" }))).not.toContain("not installed");
    // A half-finished install changed the answer, so it is worth saying again.
    missing.push("zod");
    expect(contextOf(await fire(hooks, { file_path: "/work/src/c.ts" }))).toContain("(vue, zod)");
});

test("a fully installed tree says nothing extra: the diagnostics stand on their own", async () => {
    expect(contextOf(await runHook(withErrors, { file_path: "/work/src/app.ts" }))).not.toContain("not installed");
});

// Capture what the runner was ASKED, which is the whole of this fix: the same edit is a different question
// depending on which view of the tree it is put to.
const asked = (): { requests: DiagRequest[]; diag: DiagRunner } => {
    const requests: DiagRequest[] = [];
    return {
        requests,
        diag: async (request) => {
            requests.push(request);
            return { kind: "checked", lines: [] };
        },
    };
};

/* An anchored turn's dependencies exist ONLY inside its namespace: the worktree's node_modules are empty mount
 * points with the installed tree bound in over them, so a check that translates the path and runs out here is
 * not a weaker answer, it is a different tree with nothing installed in it. Ask in the agent's own names, and
 * enter the compiler where those names are true. */
test("an anchored turn is checked in its own names, by a compiler entered into its namespace", async () => {
    const { requests, diag } = asked();
    await fire(editDiagnosticsHooks(ANCHORED, diag, RESOLVABLE), { file_path: `${WORKSPACE_ROOT}/src/app.ts` });
    const [request] = requests;
    expect(request?.file).toBe("/work/src/app.ts");
    // The wrapper is what runs the compiler on the far side; without it the check reads a tree with nothing in it.
    expect(request?.placement?.enter("/usr/bin/env", ["-C", "/work", "tsgo", "--noEmit"])).toEqual({
        command: "nsenter",
        args: ["--mount=/proc/4321/ns/mnt", "--wdns=/work", "--", "/usr/bin/env", "-C", "/work", "tsgo", "--noEmit"],
    });
});

// No namespace was built, so the worktree is reachable from here and the translation is the whole of it.
test("an unanchored turn is checked on the worktree path, with no compiler to enter", async () => {
    const { requests, diag } = asked();
    await fire(editDiagnosticsHooks(UNANCHORED, diag, RESOLVABLE), { file_path: `${WORKSPACE_ROOT}/src/app.ts` });
    expect(requests[0]?.file).toBe("/history/worktrees/c1/src/app.ts");
    expect(requests[0]?.placement).toBeUndefined();
});

/* A worktree path is a real path the agent can open and the wrong one to hand it: reaching it directly is what
 * puts a turn's edits outside its own namespace. Whatever the check was asked, the report comes back in the
 * names the agent uses. */
test("an unanchored report is renamed back to the paths the agent knows", async () => {
    const { requests, diag } = asked();
    await fire(editDiagnosticsHooks(UNANCHORED, diag, RESOLVABLE), { file_path: `${WORKSPACE_ROOT}/src/app.ts` });
    expect(requests[0]?.named("/history/worktrees/c1/src/app.ts")).toBe("/work/src/app.ts");
});

test("an anchored report is already in the agent's names and is left alone", async () => {
    const { requests, diag } = asked();
    await fire(editDiagnosticsHooks(ANCHORED, diag, RESOLVABLE), { file_path: `${WORKSPACE_ROOT}/src/app.ts` });
    expect(requests[0]?.named("/work/src/app.ts")).toBe("/work/src/app.ts");
});

/* Agents edit in bursts, and six edits to one file re-check the same program and produce the same list: one
 * report went out verbatim 2,923 times across the transcripts. Saying it again teaches nothing. */
test("a report identical to this file's last one is not sent twice", async () => {
    const hooks = editDiagnosticsHooks(undefined, withErrors, RESOLVABLE);
    expect(contextOf(await fire(hooks, { file_path: "/work/src/app.ts" }))).toContain("error TS2304");
    expect(await fire(hooks, { file_path: "/work/src/app.ts" })).toEqual({});
    // Another file failing the same way is a different fact, and still told.
    expect(contextOf(await fire(hooks, { file_path: "/work/src/other.ts" }))).toContain("error TS2304");
});

test("a changed report is always news, even to the same file", async () => {
    const lines = ["src/app.ts:12:5: error TS2304: Cannot find name 'foo'."];
    const hooks = editDiagnosticsHooks(undefined, async () => ({ kind: "checked", lines: [...lines] }), RESOLVABLE);
    expect(contextOf(await fire(hooks, { file_path: "/work/src/app.ts" }))).toContain("TS2304");
    lines[0] = "src/app.ts:12:5: error TS2322: Type 'number' is not assignable to type 'string'.";
    expect(contextOf(await fire(hooks, { file_path: "/work/src/app.ts" }))).toContain("TS2322");
});

// Suppression must not outlive what it suppressed: a file that came clean and breaks the same way again is news.
test("a file that goes clean and breaks again is reported again", async () => {
    let lines: string[] = ["src/app.ts:12:5: error TS2304: Cannot find name 'foo'."];
    const hooks = editDiagnosticsHooks(undefined, async () => ({ kind: "checked", lines }), RESOLVABLE);
    expect(contextOf(await fire(hooks, { file_path: "/work/src/app.ts" }))).toContain("TS2304");
    lines = [];
    expect(await fire(hooks, { file_path: "/work/src/app.ts" })).toEqual({});
    lines = ["src/app.ts:12:5: error TS2304: Cannot find name 'foo'."];
    expect(contextOf(await fire(hooks, { file_path: "/work/src/app.ts" }))).toContain("TS2304");
});
