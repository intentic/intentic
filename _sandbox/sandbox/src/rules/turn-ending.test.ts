import { WORKSPACE_ROOT } from "@intentic/constants";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { GitRunner } from "@intentic/scaffold";
import type { Rule } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import type { ChecksProbe } from "../agent/verification/agent-verification.js";
import { syncHookOutput } from "../testing.js";
import type { RuleCommandRun } from "./rule-command.js";
import { TEST_WRITING_NOTE } from "../agent/verification/agent-tests.js";
import { commandRuleFindings, type TurnEndingDeps, turnEndingHooks } from "./turn-ending.js";

// Which commands a project offers is the probe's business; covered by agent-verification.integration.test.ts.
const CHECKS: ChecksProbe = async () => ["pnpm test", "pnpm lint"];
const NO_PROJECT: ChecksProbe = async () => undefined;

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

// Drives the hook set the way the SDK does: finds a hook by matcher/tool name, not position, so tests can interleave
// edits, commands and stops against one ledger.
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

// Named the way the MCP server names it; whether it counts as looking is the ledger's call.
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

const armed = (rules: readonly Rule[], deps: TurnEndingDeps = {}) => turnEndingHooks(rules, { checks: CHECKS, ...deps });

const PASSED = "all good\n--- [exit 0, 2s] 40 lines filtered to 12\n";
const FAILED = "1 failed\n--- [exit 1, 2s] 40 lines filtered to 12\n";

describe("no rules", () => {
    test("wires no hooks at all", () => {
        expect(turnEndingHooks([])).toEqual({});
    });

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

    test("but a look BEFORE the last surface edit does not", async () => {
        const hooks = armed([VIEWING]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.vue`);
        await browse(hooks, LOOK);
        await edit(hooks, `${WORKSPACE_ROOT}/src/Other.vue`);
        expect(await stop(hooks)).toContain("Other.vue");
    });

    test("a browser call that observes nothing does not clear it", async () => {
        const hooks = armed([VIEWING]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.vue`);
        await browse(hooks, "mcp__web__browser_close");
        await browse(hooks, "mcp__web__browser_resize");
        expect(await stop(hooks)).toContain("App.vue");
    });

    test("a turn that touched no rendered surface says nothing", async () => {
        const hooks = armed([VIEWING]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/parser.ts`);
        await edit(hooks, `${WORKSPACE_ROOT}/README.md`);
        expect(await stop(hooks)).toBeUndefined();
    });

    test("a passing check does not stand in for looking", async () => {
        const hooks = armed([VIEWING]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.vue`);
        await bash(hooks, "pnpm test", PASSED);
        expect(await stop(hooks)).toContain("App.vue");
    });

    test("stands beside verify-edits in a single follow-up", async () => {
        const verify: Rule = { ...VIEWING, id: "verify-edits", label: "Verify", action: { kind: "builtin", name: "verify-edits" } };
        const hooks = armed([verify, VIEWING]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.vue`);
        const asked = await stop(hooks);
        expect(asked).toContain("App.vue");
        expect(asked).toContain("pnpm test");
        expect(asked?.split("\n").length).toBeGreaterThan(1);
    });

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

    // A PRE hook: reads the file as the turn found it, before this test's own edit changes the tracked tree.
    const beforeEdit = async (hooks: ReturnType<typeof turnEndingHooks>, file_path: string) => {
        const matcher = hooks.PreToolUse![0]!;
        const input = { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path }, tool_use_id: "t" } as unknown as HookInput;
        return matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
    };

    const tree = (files: Record<string, string>) => ({
        read: async (path: string) => files[path],
        set: (path: string, content: string | undefined) => (content === undefined ? delete files[path] : (files[path] = content)),
    });

    const git =
        (rows: readonly (readonly [string, number, string])[]): GitRunner =>
        async () => ({
            stdout: rows.map(([hash, at, subject]) => [hash, String(at), subject].join("\u001f")).join("\n"),
            stderr: "",
        });

    // 400 days before the fixed clock, so "untouched for a long time" is a stated fact, not a real wait.
    const NOW = Date.UTC(2026, 7, 28);
    const OLD = Math.floor((NOW - 400 * 86_400_000) / 1000);

    test("no rule reading it ⇒ no snapshot hook, so no file is read on any edit", () => {
        expect(turnEndingHooks([VERIFY]).PreToolUse).toBeUndefined();
        expect(turnEndingHooks([REMOVALS]).PreToolUse).toEqual(expect.any(Array));
    });

    test("a defended line that went is put back in front of the turn", async () => {
        const files = tree({ [`${WORKSPACE_ROOT}/src/a.ts`]: `${SLEEP}\nconst kept = 1;\n` });
        const hooks = armed([REMOVALS], {
            cwd: WORKSPACE_ROOT,
            read: files.read,
            git: git([["a91d33", OLD, "fix: export dies on cold replica"]]),
            now: NOW,
        });
        await beforeEdit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        files.set(`${WORKSPACE_ROOT}/src/a.ts`, `const kept = 1;\n`);
        const nudge = await stop(hooks);
        expect(nudge).toContain(SLEEP);
        expect(nudge).toContain(`a91d33 "fix: export dies on cold replica"`);
    });

    test("adding code says nothing, whatever its history", async () => {
        const files = tree({ [`${WORKSPACE_ROOT}/src/a.ts`]: `const kept = 1;\n` });
        const hooks = armed([REMOVALS], {
            cwd: WORKSPACE_ROOT,
            read: files.read,
            git: git([["a91d33", OLD, "fix: export dies on cold replica"]]),
            now: NOW,
        });
        await beforeEdit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        files.set(`${WORKSPACE_ROOT}/src/a.ts`, `const kept = 1;\n${SLEEP}\n`);
        expect(await stop(hooks)).toBeUndefined();
    });

    test("it rides the same follow-up as the proof ledger", async () => {
        const files = tree({ [`${WORKSPACE_ROOT}/src/a.ts`]: `${SLEEP}\n` });
        const hooks = armed([VERIFY, REMOVALS], {
            cwd: WORKSPACE_ROOT,
            read: files.read,
            git: git([["a91d33", OLD, "fix: export dies on cold replica"]]),
            now: NOW,
        });
        await beforeEdit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        files.set(`${WORKSPACE_ROOT}/src/a.ts`, ``);
        const nudge = await stop(hooks);
        expect(nudge).toContain(SLEEP);
        expect(nudge).toContain("a.ts");
    });
});

describe("the verify-edits built-in", () => {
    test("edited code with no check is asked to run the project's own check", async () => {
        const hooks = armed([VERIFY]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        const nudge = await stop(hooks);
        expect(nudge).toContain("/work/src/a.ts");
        expect(nudge).toContain("`pnpm test`");
        expect(nudge).toContain("`pnpm lint`");
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

    test("a file under no project at all is told to pick its own check, not given an invented one", async () => {
        const hooks = armed([VERIFY], { checks: NO_PROJECT });
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

    test("the SDK's re-entry flag does not suppress the second round: the repair is re-measured", async () => {
        const runs: string[] = [];
        const check = rule({ id: "check", action: { kind: "command", command: "pnpm verify", timeoutMs: 900_000 } });
        const hooks = armed([check], {
            runCommand: async () => {
                runs.push("ran");
                return { status: "failed", exitCode: 1, output: "1 failed" };
            },
        });
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        expect(await stop(hooks)).toContain("exited 1");
        expect(await stop(hooks, true)).toContain("exited 1");
        expect(runs).toEqual(["ran", "ran"]);
        expect(await stop(hooks, true)).toBeUndefined();
    });

    test("a check that passes on the second round ends the turn silently, and the land is told the last verdict", async () => {
        const verdicts: string[] = [];
        let attempt = 0;
        const check = rule({ id: "check", action: { kind: "command", command: "pnpm verify", timeoutMs: 900_000 } });
        const hooks = armed([check], {
            runCommand: async () => {
                attempt += 1;
                return attempt === 1 ? { status: "failed", exitCode: 1, output: "1 failed" } : { status: "passed", exitCode: 0, output: "ok" };
            },
            onCheckRun: (fired, run) => verdicts.push(`${fired.id}:${run.status}`),
        });
        expect(await stop(hooks)).toContain("exited 1");
        expect(await stop(hooks, true)).toBeUndefined();
        expect(verdicts).toEqual(["check:failed", "check:passed"]);
    });

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

describe("the verify-tests built-in", () => {
    const TESTS: Rule = {
        id: "verify-tests",
        label: "Check what it did to the tests",
        moment: "turn.ending",
        action: { kind: "builtin", name: "verify-tests" },
        enabled: true,
    };

    // The answer comes from the planner (agent-tests.ts); this moment only relays it.
    test("says what the tree said about the turn's tests, and nothing without a tree to read", async () => {
        const hooks = armed([TESTS], { tests: async () => "src/a.test.ts got weaker than at HEAD" });
        expect(await stop(hooks)).toContain("src/a.test.ts got weaker than at HEAD");
        expect(await stop(armed([TESTS], { tests: async () => undefined }))).toBeUndefined();
        expect(await stop(armed([TESTS]))).toBeUndefined();
    });

    test("the first test file a turn edits gets the two rules that apply to it, once, and only when the rule stands", async () => {
        const hooks = armed([TESTS]);
        const first = await edit(hooks, `${WORKSPACE_ROOT}/src/a.test.ts`);
        expect((syncHookOutput(first).hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext).toBe(TEST_WRITING_NOTE);
        expect(await edit(hooks, `${WORKSPACE_ROOT}/src/b.test.ts`)).toEqual({});
        expect(await edit(armed([TESTS]), `${WORKSPACE_ROOT}/src/a.ts`)).toEqual({});
        expect(await edit(armed([VERIFY]), `${WORKSPACE_ROOT}/src/a.test.ts`)).toEqual({});
    });
});

describe("conditions", () => {
    // Read at the Stop, not at planning time, since nothing yet knows which files a turn will touch when planned.
    test("a path condition is read against what the turn actually edited", async () => {
        const sql = rule({ id: "sql", when: { paths: ["**/*.sql"] }, action: { kind: "instruct", text: "Mention the migration." } });
        const touched = armed([sql], { cwd: WORKSPACE_ROOT });
        await edit(touched, `${WORKSPACE_ROOT}/db/0001.sql`);
        expect(await stop(touched)).toContain("Mention the migration.");

        const untouched = armed([sql], { cwd: "/work" });
        await edit(untouched, `${WORKSPACE_ROOT}/src/a.ts`);
        expect(await stop(untouched)).toBeUndefined();
    });

    // The edit ledger only hears Edit/Write; a shell rewrite (sed -i, a heredoc) is invisible to it, so the tree's own
    // diff is read too.
    test("a path condition also sees what the tree changed, however it was edited", async () => {
        const sql = rule({ id: "sql", when: { paths: ["**/*.sql"] }, action: { kind: "instruct", text: "Mention the migration." } });
        const hooks = armed([sql], { cwd: WORKSPACE_ROOT, changedPaths: async () => ["db/0001.sql"] });
        // No Edit or Write reached the ledger: the migration was written by a shell command.
        expect(await stop(hooks)).toContain("Mention the migration.");
    });

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

    test("on a turn with no runner says nothing at all", async () => {
        expect(await stop(armed([failing]))).toBeUndefined();
    });

    // A check run mid-install has measured nothing: its binary can vanish and return, so "not found" is a fact about
    // node_modules, not the diff.
    test("that failed while an install was running is not reported as a verdict", async () => {
        const hooks = armed([failing], {
            runCommand: async () => ({ status: "failed", exitCode: 1, output: "sh: 1: oxlint: not found" }),
            installing: async () => ["intentic"],
        });
        const nudge = await stop(hooks);
        expect(nudge).toContain("could not measure anything");
        expect(nudge).toContain("intentic");
        expect(nudge).toContain("nothing here needs repairing");
        expect(nudge).not.toContain("Repair that before finishing");
    });

    // Catches what `installing` alone misses: the install can finish between the failing run and the read, so the check
    // is re-run before being believed.
    test("that lost its own toolchain mid-run is re-run rather than believed", async () => {
        const outputs = ["sh: 1: oxlint: not found", ""];
        let runs = 0;
        const hooks = armed([failing], {
            runCommand: async () => {
                const output = outputs[runs] ?? "";
                runs += 1;
                return output === "" ? { status: "passed", exitCode: 0, output } : { status: "failed", exitCode: 1, output };
            },
            installing: async () => [],
        });
        expect(await stop(hooks)).toBeUndefined();
        expect(runs).toBe(2);
    });

    // Still gone on the re-run is a real toolchain gap, not a diff problem, so it's reported as such rather than as a
    // repair request.
    test("that still has no toolchain on the re-run says so instead of blaming the diff", async () => {
        let runs = 0;
        const hooks = armed([failing], {
            runCommand: async () => {
                runs += 1;
                return { status: "failed", exitCode: 1, output: "sh: 1: oxlint: not found" };
            },
            installing: async () => [],
        });
        const nudge = await stop(hooks);
        expect(runs).toBe(2);
        expect(nudge).toContain("could not measure anything");
        expect(nudge).toContain("`oxlint`");
        expect(nudge).not.toContain("Repair that before finishing");
    });

    test("that failed on its own merits is run once and reported as a verdict", async () => {
        let runs = 0;
        const hooks = armed([failing], {
            runCommand: async () => {
                runs += 1;
                return { status: "failed", exitCode: 1, output: "src/a.ts:1:1 error: unused variable" };
            },
            installing: async () => [],
        });
        const nudge = await stop(hooks);
        expect(runs).toBe(1);
        expect(nudge).toContain("Repair that before finishing");
        expect(nudge).not.toContain("could not measure anything");
    });

    test("that failed on a settled tree is still a verdict", async () => {
        const hooks = armed([failing], {
            runCommand: async () => ({ status: "failed", exitCode: 2, output: "3 problems" }),
            installing: async () => [],
        });
        const nudge = await stop(hooks);
        expect(nudge).toContain("exited 2");
        expect(nudge).toContain("Repair that before finishing");
    });

    // `error` (rule-command.ts) means the command never ran; no repair is asked for it.
    test("that never ran at all asks for no repair", async () => {
        const hooks = armed([failing], run({ status: "error", output: "no such cwd" }));
        const nudge = await stop(hooks);
        expect(nudge).toContain("could not measure anything");
        expect(nudge).toContain("no such cwd");
        expect(nudge).not.toContain("Repair that before finishing");
    });
});

describe("reporting", () => {
    test("only rules that actually said something are reported as fired", async () => {
        const fired: string[] = [];
        const quiet = rule({ id: "quiet", when: { paths: ["**/*.sql"] }, action: { kind: "instruct", text: "unreachable" } });
        const loud = rule({ id: "loud", action: { kind: "instruct", text: "Say what you did." } });
        const hooks = armed([VERIFY, quiet, loud], { onFired: (r) => fired.push(r.id) });
        // No edits: verify-edits has nothing to ask for, and the sql rule's condition cannot hold.
        await stop(hooks);
        expect(fired).toEqual(["loud"]);
    });
});

describe("the daemon's own run of the command rules", () => {
    const CHECK = rule({ id: "check", label: "Verify before you finish", action: { kind: "command", command: "pnpm verify:turn", timeoutMs: 900_000 } });

    test("a failing command is one finding worded for the model, told to onCheckRun and onFired", async () => {
        const runs: string[] = [];
        const checked: string[] = [];
        const fired: string[] = [];
        const findings = await commandRuleFindings([CHECK], { paths: ["src/a.ts"] }, {
            runCommand: async (command) => {
                runs.push(command);
                return { status: "failed", exitCode: 1, output: FAILED };
            },
            onCheckRun: (checkRule, run) => checked.push(`${checkRule.id}:${run.status}`),
            onFired: (checkRule) => fired.push(checkRule.id),
        });
        expect(runs).toEqual(["pnpm verify:turn"]);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toContain('"Verify before you finish" ran this and it exited 1');
        expect(checked).toEqual(["check:failed"]);
        expect(fired).toEqual(["check"]);
    });

    test("a passing command is no finding, and a rule whose condition the paths miss is not run", async () => {
        const runs: string[] = [];
        const runCommand = async (command: string) => {
            runs.push(command);
            return { status: "passed" as const, exitCode: 0, output: PASSED };
        };
        expect(await commandRuleFindings([CHECK], { paths: ["src/a.ts"] }, { runCommand })).toEqual([]);
        const narrowed = { ...CHECK, when: { paths: ["intentic/**"] } };
        expect(await commandRuleFindings([narrowed], { paths: ["docs/a.md"] }, { runCommand })).toEqual([]);
        expect(runs).toEqual(["pnpm verify:turn"]);
    });

    test("with nowhere to run a command, nothing is invented", async () => {
        expect(await commandRuleFindings([CHECK], { paths: ["src/a.ts"] }, {})).toEqual([]);
    });
});

describe("what a follow-up bought", () => {
    const CHECK = rule({ id: "check", label: "Verify before you finish", action: { kind: "command", command: "pnpm verify:turn", timeoutMs: 900_000 } });

    test("the Stop after a follow-up reports the edits and commands since, per rule that spoke", async () => {
        const outcomes: { id: string; edits: number; looks: number; commands: number }[] = [];
        const hooks = armed([CHECK], {
            runCommand: async () => ({ status: "failed", exitCode: 1, output: FAILED }),
            onFollowUpOutcome: (spoke, outcome) => outcomes.push({ id: spoke.id, ...outcome }),
        });
        expect(await stop(hooks)).toContain("Verify before you finish");
        expect(outcomes).toEqual([]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        await edit(hooks, `${WORKSPACE_ROOT}/src/b.ts`);
        await bash(hooks, "pnpm test", PASSED);
        await stop(hooks);
        expect(outcomes).toEqual([{ id: "check", edits: 2, looks: 0, commands: 1 }]);
    });

    test("a Stop that asked nothing settles nothing", async () => {
        const outcomes: unknown[] = [];
        const hooks = armed([CHECK], {
            runCommand: async () => ({ status: "passed", exitCode: 0, output: PASSED }),
            onFollowUpOutcome: (spoke, outcome) => outcomes.push([spoke.id, outcome]),
        });
        expect(await stop(hooks)).toBeUndefined();
        await edit(hooks, `${WORKSPACE_ROOT}/src/a.ts`);
        expect(await stop(hooks)).toBeUndefined();
        expect(outcomes).toEqual([]);
    });
});
