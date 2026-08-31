import { WORKSPACE_ROOT } from "@intentic/constants";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { GitRunner } from "@intentic/scaffold";
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

/* Drive a hook set the way the SDK does. Each helper fires one event at the set built for a single turn, so a
 * test can interleave edits, commands and stops against ONE ledger, which is the whole thing under test.
 *
 * The matcher is found BY TOOL NAME rather than by position, the same way the SDK dispatches. These helpers
 * used to index the array, which meant every hook added to a moment silently re-pointed some other helper at
 * the wrong matcher: adding the browser hook sent `bash` at it, and three tests failed claiming the proof
 * ledger had stopped recording commands. */
const pick = (hooks: ReturnType<typeof turnEndingHooks>, event: "PostToolUse" | "PostToolUseFailure", toolName: string) => {
    const found = hooks[event]?.find((entry) => entry.matcher !== undefined && new RegExp(`^(?:${entry.matcher})$`).test(toolName));
    if (found === undefined) {
        throw new Error(`no ${event} matcher for ${toolName}`);
    }
    return found;
};

const edit = async (hooks: ReturnType<typeof turnEndingHooks>, file_path: string) => {
    const matcher = pick(hooks, "PostToolUse", "Edit");
    const input = { hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path }, tool_use_id: "t" } as unknown as HookInput;
    return matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
};

// One browser call, by the name the MCP server gives it: whether it COUNTS as looking is the ledger's call.
const browse = async (hooks: ReturnType<typeof turnEndingHooks>, tool_name: string) => {
    const matcher = pick(hooks, "PostToolUse", tool_name);
    const input = { hook_event_name: "PostToolUse", tool_name, tool_input: {}, tool_use_id: "t" } as unknown as HookInput;
    return matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
};

const bash = async (hooks: ReturnType<typeof turnEndingHooks>, command: string, response: string) => {
    const matcher = pick(hooks, "PostToolUse", "Bash");
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
    const matcher = pick(hooks, "PostToolUseFailure", "Bash");
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

describe("the verify-ui-edits built-in", () => {
    const VIEWING: Rule = {
        id: "verify-ui-edits",
        label: "Look at what it changed",
        moment: "turn.ending",
        action: { kind: "builtin", name: "verify-ui-edits" },
        enabled: true,
    };

    const LOOK = "mcp__web__browser_take_screenshot";

    test("a turn that changed a stylesheet and never opened a browser is asked to look", async () => {
        const hooks = armed([VIEWING]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.css`);
        const asked = await stop(hooks);
        expect(asked).toContain("App.css");
        expect(asked).not.toBe(await stop(armed([VIEWING])));
    });

    test("a look after the last surface edit clears it", async () => {
        const hooks = armed([VIEWING]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.vue`);
        await browse(hooks, LOOK);
        expect(await stop(hooks)).toBeUndefined();
    });

    /* ORDER IS THE WHOLE POINT, the same property the proof ledger is built on. A screenshot taken before the
     * last three CSS edits is not evidence about them, and a scheme that only asked "did this turn use a
     * browser at all" would read this turn as verified. */
    test("but a look BEFORE the last surface edit does not", async () => {
        const hooks = armed([VIEWING]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.vue`);
        await browse(hooks, LOOK);
        await edit(hooks, `${WORKSPACE_ROOT}/src/Other.vue`);
        expect(await stop(hooks)).toContain("Other.vue");
    });

    // Opening a browser and closing it is not looking at anything, and a gate any browser call could clear
    // would be cleared by exactly the turn it exists to catch.
    test("a browser call that observes nothing does not clear it", async () => {
        const hooks = armed([VIEWING]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.vue`);
        await browse(hooks, "mcp__web__browser_close");
        await browse(hooks, "mcp__web__browser_resize");
        expect(await stop(hooks)).toContain("App.vue");
    });

    // The allowlist is the deliberate half: a spurious ask here costs a whole model turn, so anything that is
    // not unambiguously a rendered surface is somebody else's question.
    test("a turn that touched no rendered surface says nothing", async () => {
        const hooks = armed([VIEWING]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/parser.ts`);
        await edit(hooks, `${WORKSPACE_ROOT}/README.md`);
        expect(await stop(hooks)).toBeUndefined();
    });

    // The two turn.ending builtins read different halves of the same turn, and neither may answer for the
    // other: a green suite says nothing about a clipped label.
    test("a passing check does not stand in for looking", async () => {
        const hooks = armed([VIEWING]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.vue`);
        await bash(hooks, "pnpm test", PASSED);
        expect(await stop(hooks)).toContain("App.vue");
    });

    // Both standing is two things to say and one follow-up to say them in, the moment's one budget.
    test("stands beside verify-edits in a single follow-up", async () => {
        const verify: Rule = { ...VIEWING, id: "verify-edits", label: "Verify", action: { kind: "builtin", name: "verify-edits" } };
        const hooks = armed([verify, VIEWING]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.vue`);
        const asked = await stop(hooks);
        expect(asked).toContain("App.vue");
        expect(asked).toContain("pnpm test");
        expect(asked?.split("\n").length).toBeGreaterThan(1);
    });

    // A path condition narrows this moment like any other, and it reads the paths the turn really touched.
    test("honours a path condition", async () => {
        const scoped = { ...VIEWING, when: { paths: ["src/legacy/**"] } };
        const hooks = armed([scoped]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.vue`);
        expect(await stop(hooks)).toBeUndefined();
    });
});

describe("the verify-removals built-in", () => {
    const REMOVALS: Rule = {
        id: "verify-removals",
        label: "Check what it deleted",
        moment: "turn.ending",
        action: { kind: "builtin", name: "verify-removals" },
        enabled: true,
    };

    const SLEEP = `await sleep(2000); // let the replica catch up`;

    /* The snapshot hook, driven as the SDK drives it. It is a PRE hook, so what it reads is the file as the
     * turn found it: these tests hand it a reader over a tree the test then changes, which is exactly the
     * sequence a real edit produces. */
    const beforeEdit = async (hooks: ReturnType<typeof turnEndingHooks>, file_path: string) => {
        const matcher = hooks.PreToolUse![0]!;
        const input = { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path }, tool_use_id: "t" } as unknown as HookInput;
        return matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
    };

    const tree = (files: Record<string, string>) => ({
        read: async (path: string) => files[path],
        set: (path: string, content: string | undefined) => (content === undefined ? delete files[path] : (files[path] = content)),
    });

    const git = (rows: readonly (readonly [string, number, string])[]): GitRunner => async () => ({
        stdout: rows.map(([hash, at, subject]) => [hash, String(at), subject].join("\u001f")).join("\n"),
        stderr: "",
    });

    // 400 days before the fixed clock the deps carry, so "untouched for a long time" is stated, not waited for.
    const NOW = Date.UTC(2026, 7, 28);
    const OLD = Math.floor((NOW - 400 * 86_400_000) / 1000);

    test("no rule reading it ⇒ no snapshot hook, so no file is read on any edit", () => {
        expect(turnEndingHooks([VERIFY]).PreToolUse).toBeUndefined();
        expect(turnEndingHooks([REMOVALS]).PreToolUse).toEqual(expect.any(Array));
    });

    test("a defended line that went is put back in front of the turn", async () => {
        const files = tree({ [`${WORKSPACE_ROOT}/src/a.ts`]: `${SLEEP}\nconst kept = 1;\n` });
        const hooks = armed([REMOVALS], { cwd: WORKSPACE_ROOT, read: files.read, git: git([["a91d33", OLD, "fix: export dies on cold replica"]]), now: NOW });
        await beforeEdit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        files.set(`${WORKSPACE_ROOT}/src/a.ts`, `const kept = 1;\n`);
        const nudge = await stop(hooks);
        expect(nudge).toContain(SLEEP);
        expect(nudge).toContain(`a91d33 "fix: export dies on cold replica"`);
    });

    test("adding code says nothing, whatever its history", async () => {
        const files = tree({ [`${WORKSPACE_ROOT}/src/a.ts`]: `const kept = 1;\n` });
        const hooks = armed([REMOVALS], { cwd: WORKSPACE_ROOT, read: files.read, git: git([["a91d33", OLD, "fix: export dies on cold replica"]]), now: NOW });
        await beforeEdit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        files.set(`${WORKSPACE_ROOT}/src/a.ts`, `const kept = 1;\n${SLEEP}\n`);
        expect(await stop(hooks)).toBeUndefined();
    });

    // Both built-ins stand at this moment and read different halves of the same turn; one budget, one follow-up.
    test("it rides the same follow-up as the proof ledger", async () => {
        const files = tree({ [`${WORKSPACE_ROOT}/src/a.ts`]: `${SLEEP}\n` });
        const hooks = armed([VERIFY, REMOVALS], { cwd: WORKSPACE_ROOT, read: files.read, git: git([["a91d33", OLD, "fix: export dies on cold replica"]]), now: NOW });
        await beforeEdit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        files.set(`${WORKSPACE_ROOT}/src/a.ts`, ``);
        const nudge = await stop(hooks);
        expect(nudge).toContain(SLEEP);
        expect(nudge).toContain("a.ts");
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
        // `dev` is a script but not a check: offering it would be worse than offering nothing.
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
        expect(nudge).toContain("thing.py");
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
    test("at most two asks per turn: the third stop is silent", async () => {
        const hooks = armed([VERIFY]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        expect(await stop(hooks)).toEqual(expect.any(String));
        expect(await stop(hooks)).toEqual(expect.any(String));
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
        expect(first).toContain("a.ts");
        expect(first).toContain("Update the changelog.");
        expect(await stop(hooks)).toEqual(expect.any(String));
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
