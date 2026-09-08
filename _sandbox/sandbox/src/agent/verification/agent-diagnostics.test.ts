import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { HookInput, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { expect, test } from "vitest";
import type { IsolationPlan, TurnPlacement } from "../../agents/worktrees/isolation.js";
import { syncHookOutput } from "../../testing.js";
import { type DiagRequest, type DiagRunner, editDiagnosticsHooks, type ModulesProbe } from "./agent-diagnostics.js";
import { EDIT_TOOLS } from "../../rules/edit-tools.js";
import type { ShellEdit, ShellEditTracker } from "../tools/agent-shell-edits.js";

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
// A tree that exists and is behind: the state left when a dependency is added but not installed.
const stale =
    (...missing: string[]): ModulesProbe =>
    async () => ({ kind: "installed", missing });

// Fires one edit at a hook set, separately from runHook, so a test can drive the same set twice and observe per-turn
// state.
const fire = async (hooks: ReturnType<typeof editDiagnosticsHooks>, toolInput: unknown) => {
    const [matcher] = hooks.PostToolUse!;
    const input = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: toolInput, tool_use_id: "t1" } as unknown as HookInput;
    return matcher!.hooks[0]!(input, "t1", { signal: new AbortController().signal });
};

// Drives the PostToolUse hook directly with a fake lsp runner; dependencies are present unless a test says otherwise.
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

// undefined means there is no answer to be had (no tsconfig above the file); it must read the same as clean.
test("an unanswerable check stays silent", async () => {
    const result = await runHook(async () => undefined, { file_path: `${WORKSPACE_ROOT}/src/app.ts` });
    expect(result).toEqual({});
});

test("a tool input without a file path stays silent", async () => {
    const result = await runHook(withErrors, { command: "echo hi" });
    expect(result).toEqual({});
});

// Without node_modules the compiler can't resolve any import, even node: builtins, so it would report errors the edit
// never touched; the check must not run at all.
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

// A checker refusal surfaces as the once-per-turn unavailability sentence, never as diagnostics.
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

// A partially installed tree (node_modules exists, one added package missing) still type-checks; only the
// unresolved-import diagnostics need the extra sentence.
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

// Captures what the runner was asked: the same edit is a different question depending on which view of the tree it's
// put to.
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

// An anchored turn's dependencies exist only inside its namespace: the worktree's node_modules are empty mounts bound
// in over it. Checked in the agent's own names, with the compiler entered where those names are true.
test("an anchored turn is checked in its own names, by a compiler entered into its namespace", async () => {
    const { requests, diag } = asked();
    await fire(editDiagnosticsHooks(ANCHORED, diag, RESOLVABLE), { file_path: `${WORKSPACE_ROOT}/src/app.ts` });
    const [request] = requests;
    expect(request?.file).toBe("/work/src/app.ts");
    // The wrapper is what runs the compiler on the far side; without it the check reads a tree with nothing in it.
    expect(request?.placement?.enter("/usr/bin/env", ["-C", "/work", "tsgo", "--noEmit"])).toEqual({
        command: "nsenter",
        // `env -u PWD -u OLDPWD` rides between the hop and the compiler: the daemon's inherited logical cwd
        // names the worktree by its /history path, where no dependency mirror is mounted (agents/isolation.ts).
        args: ["--mount=/proc/4321/ns/mnt", "--wdns=/work", "--", "env", "-u", "PWD", "-u", "OLDPWD", "/usr/bin/env", "-C", "/work", "tsgo", "--noEmit"],
    });
});

// No namespace was built, so the worktree is reachable directly and path translation is the whole of the check.
test("an unanchored turn is checked on the worktree path, with no compiler to enter", async () => {
    const { requests, diag } = asked();
    await fire(editDiagnosticsHooks(UNANCHORED, diag, RESOLVABLE), { file_path: `${WORKSPACE_ROOT}/src/app.ts` });
    expect(requests[0]?.file).toBe("/history/worktrees/c1/src/app.ts");
    expect(requests[0]?.placement).toBeUndefined();
});

// A worktree path is real but the wrong one to hand back to the agent. Whatever the check was asked in, the report
// comes back renamed to the names the agent uses.
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

// Agents edit in bursts; re-checking the same program produces the same report, and repeating it teaches nothing.
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

// Suppression must not outlive what it suppressed: a clean file that breaks the same way again is news.
test("a file that goes clean and breaks again is reported again", async () => {
    let lines: string[] = ["src/app.ts:12:5: error TS2304: Cannot find name 'foo'."];
    const hooks = editDiagnosticsHooks(undefined, async () => ({ kind: "checked", lines }), RESOLVABLE);
    expect(contextOf(await fire(hooks, { file_path: "/work/src/app.ts" }))).toContain("TS2304");
    lines = [];
    expect(await fire(hooks, { file_path: "/work/src/app.ts" })).toEqual({});
    lines = ["src/app.ts:12:5: error TS2304: Cannot find name 'foo'."];
    expect(contextOf(await fire(hooks, { file_path: "/work/src/app.ts" }))).toContain("TS2304");
});

// A tracker says which files a Bash command changed; hooks snapshot before the command and review after through the
// same per-file reviewer an Edit uses, so once-per-turn notices and repeat suppression hold across both doors.
const tracked = (changed: readonly ShellEdit[]): ShellEditTracker & { readonly calls: string[] } => {
    const calls: string[] = [];
    return {
        calls,
        before: async () => {
            calls.push("before");
        },
        changed: async () => {
            calls.push("changed");
            return changed;
        },
    };
};

const bash = async (hooks: ReturnType<typeof editDiagnosticsHooks>, event: "PreToolUse" | "PostToolUse") => {
    const matcher = hooks[event]?.find((entry) => entry.matcher === "Bash");
    if (matcher === undefined) {
        throw new Error(`no ${event} matcher for Bash`);
    }
    const input = {
        hook_event_name: event,
        tool_name: "Bash",
        tool_input: { command: "sed -i s/a/b/ src/app.ts" },
        tool_use_id: "t2",
    } as unknown as HookInput;
    return matcher.hooks[0]!(input, "t2", { signal: new AbortController().signal });
};

test("without a tracker no Bash hook is wired at all", () => {
    const hooks = editDiagnosticsHooks(undefined, checked(), RESOLVABLE);
    expect(hooks.PreToolUse).toBeUndefined();
    expect(hooks.PostToolUse?.map((entry) => entry.matcher)).toEqual([EDIT_TOOLS]);
});

test("a TypeScript file a command changed is reviewed like an edit, in the agent's name, and the sentence names the command", async () => {
    const reviewed: string[] = [];
    const diag: DiagRunner = async ({ file }) => {
        reviewed.push(file);
        return { kind: "checked", lines: [`${file}:3:1: error TS2322: Type 'string' is not assignable to type 'number'.`] };
    };
    const tracker = tracked([
        { path: `${WORKSPACE_ROOT}/src/app.ts`, onDisk: `${WORKSPACE_ROOT}/src/app.ts` },
        { path: `${WORKSPACE_ROOT}/README.md`, onDisk: `${WORKSPACE_ROOT}/README.md` },
    ]);
    const hooks = editDiagnosticsHooks(undefined, diag, RESOLVABLE, tracker);
    expect(await bash(hooks, "PreToolUse")).toEqual({});
    const result = await bash(hooks, "PostToolUse");
    const context = (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string }).additionalContext;
    expect(tracker.calls).toEqual(["before", "changed"]);
    expect(reviewed).toEqual([`${WORKSPACE_ROOT}/src/app.ts`]);
    expect(context).toContain(`TypeScript diagnostics for ${WORKSPACE_ROOT}/src/app.ts after this command:`);
    expect(context).toContain("error TS2322");
    expect(context).toContain("Fix the errors this command introduced before finishing.");
});

test("a command that changed nothing checkable, or nothing at all, is silent", async () => {
    const hooks = editDiagnosticsHooks(
        undefined,
        withErrors,
        RESOLVABLE,
        tracked([{ path: `${WORKSPACE_ROOT}/notes.md`, onDisk: `${WORKSPACE_ROOT}/notes.md` }]),
    );
    expect(await bash(hooks, "PostToolUse")).toEqual({});
    expect(await bash(editDiagnosticsHooks(undefined, withErrors, RESOLVABLE, tracked([])), "PostToolUse")).toEqual({});
});

test("an unanchored turn reviews the worktree copy of a file the command changed", async () => {
    const reviewed: string[] = [];
    const diag: DiagRunner = async ({ file }) => {
        reviewed.push(file);
        return { kind: "checked", lines: [] };
    };
    const tracker = tracked([{ path: `${WORKSPACE_ROOT}/src/app.ts`, onDisk: `${PLAN.worktree}/src/app.ts` }]);
    await bash(editDiagnosticsHooks(UNANCHORED, diag, RESOLVABLE, tracker), "PostToolUse");
    expect(reviewed).toEqual([`${PLAN.worktree}/src/app.ts`]);
});

test("the same report from an edit and then a command is said once", async () => {
    const tracker = tracked([{ path: `${WORKSPACE_ROOT}/src/app.ts`, onDisk: `${WORKSPACE_ROOT}/src/app.ts` }]);
    const hooks = editDiagnosticsHooks(undefined, withErrors, RESOLVABLE, tracker);
    expect(
        (syncHookOutput(await fire(hooks, { file_path: `${WORKSPACE_ROOT}/src/app.ts` })).hookSpecificOutput as { additionalContext?: string })
            .additionalContext,
    ).toContain("TS2304");
    expect(await bash(hooks, "PostToolUse")).toEqual({});
});

// Drives the python half through a fake runner for the same reason the TypeScript ones above do: what's tested is the
// hook's contract, not what ruff or pyright think. Real tools are exercised in python-diagnostics.integration.test.ts.

const PY = `${WORKSPACE_ROOT}/app/main.py`;

// The TypeScript runner is handed a clean answer throughout, so nothing it says can be mistaken for the python half's.
const pythonHooks = (pythonDiag: DiagRunner) => editDiagnosticsHooks(undefined, checked(), RESOLVABLE, undefined, [], pythonDiag);

test("a python edit is checked by the python runner, and reported as python", async () => {
    const seen: string[] = [];
    const hooks = pythonHooks(async ({ file }) => {
        seen.push(file);
        return { kind: "checked", lines: [`${file}:2:12: error F821: Undefined name \`x\``] };
    });
    const context = contextOf(await fire(hooks, { file_path: PY }));
    expect(seen).toEqual([PY]);
    expect(context).toContain(`Python diagnostics for ${PY} after this edit:`);
    expect(context).toContain("error F821");
    expect(context).toContain("Fix the errors this edit introduced before finishing.");
});

test("the qualification a half-run check carries rides with its findings, and is said once", async () => {
    const note = "Note: this sandbox has no `pyright`, so the type half of this check did not run.";
    const hooks = pythonHooks(async ({ file }) => ({ kind: "checked", lines: [`${file}:1:1: error F821: Undefined name \`x\``], note }));
    expect(contextOf(await fire(hooks, { file_path: PY }))).toContain(note);
    // Same file, same errors, and the note already told: there is nothing new to say.
    expect(await fire(hooks, { file_path: PY })).toEqual({});
});

test("a clean python file still says what did not run, because silence would claim more than was checked", async () => {
    const note = "Note: no `.venv` was found above this file, so imports were not resolved.";
    const hooks = pythonHooks(async () => ({ kind: "checked", lines: [], note }));
    expect(contextOf(await fire(hooks, { file_path: PY }))).toBe(note);
    expect(await fire(hooks, { file_path: PY })).toEqual({});
});

test("a python check that could not run says so, once, and never reads as a clean file", async () => {
    const hooks = pythonHooks(async () => ({ kind: "unavailable" }));
    expect(contextOf(await fire(hooks, { file_path: PY }))).toContain("Python diagnostics are unavailable for this edit");
    expect(await fire(hooks, { file_path: PY })).toEqual({});
});

test("each language goes to its own checker, and a file neither reads goes to no checker", async () => {
    const hooks = editDiagnosticsHooks(undefined, withErrors, RESOLVABLE, undefined, [], async () => {
        throw new Error("the python checker was asked about a file that is not python");
    });
    expect(contextOf(await fire(hooks, { file_path: `${WORKSPACE_ROOT}/src/app.ts` }))).toContain("TypeScript diagnostics");
    expect(await fire(hooks, { file_path: `${WORKSPACE_ROOT}/README.md` })).toEqual({});
});
