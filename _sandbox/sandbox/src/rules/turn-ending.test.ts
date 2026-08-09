import { WORKSPACE_ROOT } from "@intentic/constants";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { Rule } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import type { ScriptsProbe } from "../agent/agent-verification.js";
import { syncHookOutput } from "../testing.js";
import type { RuleCommandRun } from "./rule-command.js";
import { type TurnEndingDeps, turnEndingHooks } from "./turn-ending.js";

const SCRIPTS: ScriptsProbe = async () => ["test", "lint", "dev"];
const NO_PACKAGE: ScriptsProbe = async () => undefined;

const VERIFY: Rule = {
    id: "verify-edits",
    label: "Verify before finishing",
    moment: "turn.ending",
    action: { kind: "builtin", name: "verify-edits" },
    enabled: true,
};

const rule = (over: Partial<Rule> & Pick<Rule, "id" | "action">): Rule => ({
    label: over.id,
    moment: "turn.ending",
    enabled: true,
    ...over,
});

// Drive a hook set the way the SDK does. Each helper fires one event at the set built for a single turn, so a
// test can interleave edits, commands and stops against ONE ledger — which is the whole thing under test.
const edit = async (hooks: ReturnType<typeof turnEndingHooks>, file_path: string) => {
    const matcher = hooks.PostToolUse![0]!;
    const input = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path }, tool_use_id: "t" } as unknown as HookInput;
    return matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
};

const bash = async (hooks: ReturnType<typeof turnEndingHooks>, command: string, response: string) => {
    const matcher = hooks.PostToolUse![1]!;
    const input = {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command },
        tool_response: response,
        tool_use_id: "t",
    } as unknown as HookInput;
    return matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
};

const bashFailed = async (hooks: ReturnType<typeof turnEndingHooks>, command: string, error: string) => {
    const matcher = hooks.PostToolUseFailure![0]!;
    const input = {
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command },
        error,
        tool_use_id: "t",
    } as unknown as HookInput;
    return matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
};

const stop = async (hooks: ReturnType<typeof turnEndingHooks>, stop_hook_active = false) => {
    const matcher = hooks.Stop![0]!;
    const input = { hook_event_name: "Stop", stop_hook_active } as unknown as HookInput;
    const result = await matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
    return (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
};

const armed = (rules: readonly Rule[], deps: TurnEndingDeps = {}) => turnEndingHooks(rules, { scripts: SCRIPTS, ...deps });

const PASSED = "all good\n--- [exit 0, 2s] 40 lines filtered to 12\n";
const FAILED = "1 failed\n--- [exit 1, 2s] 40 lines filtered to 12\n";

describe("no rules", () => {
    // The economy the whole design rests on: a workspace that has never opened this pays nothing, not even the
    // per-edit bookkeeping that would otherwise run on every tool call of every turn.
    test("wires no hooks at all", () => {
        expect(turnEndingHooks([])).toEqual({});
    });

    // `standing` filters by moment before this is ever called, so what is under test is that a rule slipping
    // through anyway is inert rather than producing a follow-up at the wrong moment.
    test("and a rule for another moment says nothing at a stop", async () => {
        const elsewhere = rule({ id: "x", moment: "push.starting", action: { kind: "command", command: "pnpm test", timeoutMs: 900_000 } });
        expect(await stop(armed([elsewhere], { runCommand: async () => ({ status: "failed", exitCode: 1, output: "no" }) }))).toBeUndefined();
    });
});

describe("the verify-edits built-in", () => {
    test("edited code with no check is asked to run the workspace's own script", async () => {
        const hooks = armed([VERIFY]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        const nudge = await stop(hooks);
        expect(nudge).toContain("/work/src/a.ts");
        expect(nudge).toContain("`pnpm test`");
        expect(nudge).toContain("`pnpm lint`");
        // `dev` is a script but not a check — offering it would be worse than offering nothing.
        expect(nudge).not.toContain("pnpm dev");
    });

    test("a passing check means the turn ends silently", async () => {
        const hooks = armed([VERIFY]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        await bash(hooks, "pnpm test", PASSED);
        expect(await stop(hooks)).toBeUndefined();
    });

    test("a non-zero exit in the footer is not a pass", async () => {
        const hooks = armed([VERIFY]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        await bash(hooks, "pnpm test", FAILED);
        expect(await stop(hooks)).toContain("did NOT pass");
    });

    test("a Bash tool failure counts as a failed check", async () => {
        const hooks = armed([VERIFY]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        await bashFailed(hooks, "pnpm test", "exit 1: 2 failed");
        expect(await stop(hooks)).toContain("2 failed");
    });

    test("a workspace with no package.json is told to pick its own check, not given an invented one", async () => {
        const hooks = armed([VERIFY], { scripts: NO_PACKAGE });
        await edit(hooks, "/srv/thing.py");
        const nudge = await stop(hooks);
        expect(nudge).toContain("defines no test/lint/typecheck script");
        expect(nudge).not.toContain("pnpm");
    });

    test("a check that fixes the failure clears the second stop", async () => {
        const hooks = armed([VERIFY]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        await bash(hooks, "pnpm test", FAILED);
        expect(await stop(hooks)).toContain("did NOT pass");
        await edit(hooks, "/work/src/a.ts");
        await bash(hooks, "pnpm test", PASSED);
        expect(await stop(hooks)).toBeUndefined();
    });
});

describe("the follow-up budget", () => {
    test("at most two asks per turn — the third stop is silent", async () => {
        const hooks = armed([VERIFY]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        expect(await stop(hooks)).toBeDefined();
        expect(await stop(hooks)).toBeDefined();
        expect(await stop(hooks)).toBeUndefined();
    });

    test("the SDK's own re-entry flag suppresses the ask on its own", async () => {
        const hooks = armed([VERIFY]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        expect(await stop(hooks, true)).toBeUndefined();
    });

    // The budget counts ASKS, not rules: three rules that each want a word are one follow-up carrying three
    // things. Counting per rule would let a turn be sent back once per rule, forever.
    test("several rules speaking at one stop spend one ask between them", async () => {
        const hooks = armed([VERIFY, rule({ id: "changelog", action: { kind: "instruct", text: "Update the changelog." } })]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        const first = await stop(hooks);
        expect(first).toContain("no check has passed");
        expect(first).toContain("Update the changelog.");
        expect(await stop(hooks)).toBeDefined();
        expect(await stop(hooks)).toBeUndefined();
    });
});

describe("conditions", () => {
    // The reason conditions are read HERE and not when the turn was planned: at planning time nothing knows
    // which files the turn will touch, so a path condition resolved then could never hold.
    test("a path condition is read against what the turn actually edited", async () => {
        const sql = rule({ id: "sql", when: { paths: ["**/*.sql"] }, action: { kind: "instruct", text: "Mention the migration." } });
        const touched = armed([sql], { cwd: WORKSPACE_ROOT });
        await edit(touched, `${WORKSPACE_ROOT}/db/0001.sql`);
        expect(await stop(touched)).toContain("Mention the migration.");

        const untouched = armed([sql], { cwd: "/work" });
        await edit(untouched, `${WORKSPACE_ROOT}/src/a.ts`);
        expect(await stop(untouched)).toBeUndefined();
    });

    // The agent names files absolutely and a rule is written the way the owner reads their tree, so one glob
    // has to mean the same thing here as it does at the landing moment.
    test("paths are relativised to the turn's tree before a glob sees them", async () => {
        const docs = rule({ id: "docs", when: { paths: ["docs/**"] }, action: { kind: "instruct", text: "Check the docs build." } });
        const hooks = armed([docs], { cwd: `${WORKSPACE_ROOT}/repo` });
        await edit(hooks, `${WORKSPACE_ROOT}/repo/docs/intro.md`);
        expect(await stop(hooks)).toContain("Check the docs build.");
    });

    test("a rule with no condition still fires on a turn that edited nothing", async () => {
        const always = rule({ id: "always", action: { kind: "instruct", text: "Say what you did." } });
        expect(await stop(armed([always]))).toContain("Say what you did.");
    });
});

describe("a command rule", () => {
    const failing = rule({ id: "lint", action: { kind: "command", command: "pnpm lint", timeoutMs: 60_000 } });
    const run = (result: RuleCommandRun): TurnEndingDeps => ({ runCommand: async () => result });

    test("that passes lets the turn end", async () => {
        const hooks = armed([failing], run({ status: "passed", exitCode: 0, output: "" }));
        expect(await stop(hooks)).toBeUndefined();
    });

    test("that fails sends its own output back with the rule's name on it", async () => {
        const hooks = armed([failing], run({ status: "failed", exitCode: 2, output: "3 problems" }));
        const nudge = await stop(hooks);
        expect(nudge).toContain("lint");
        expect(nudge).toContain("exited 2");
        expect(nudge).toContain("3 problems");
    });

    test("that timed out says so rather than quoting an exit code it never got", async () => {
        const hooks = armed([failing], run({ status: "failed", timedOut: true, output: "" }));
        expect(await stop(hooks)).toContain("timed out after 60s");
    });

    // A turn with nowhere to run a command (ACP, the translator) must not invent a result: claiming a check
    // ran is exactly the failure this whole area exists to prevent.
    test("on a turn with no runner says nothing at all", async () => {
        expect(await stop(armed([failing]))).toBeUndefined();
    });
});

describe("reporting", () => {
    test("only rules that actually said something are reported as fired", async () => {
        const fired: string[] = [];
        const quiet = rule({ id: "quiet", when: { paths: ["**/*.sql"] }, action: { kind: "instruct", text: "unreachable" } });
        const loud = rule({ id: "loud", action: { kind: "instruct", text: "Say what you did." } });
        const hooks = armed([VERIFY, quiet, loud], { onFired: (r) => fired.push(r.id) });
        // No edits ⇒ verify-edits has nothing to ask for, and the sql rule's condition cannot hold.
        await stop(hooks);
        expect(fired).toEqual(["loud"]);
    });
});
