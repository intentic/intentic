import { WORKSPACE_ROOT } from "@intentic/constants";
import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { Rule } from "@intentic/sandbox-contract";
import { syncHookOutput } from "../testing.js";
import type { RuleCommandRun } from "./rule-command.js";
import { commandRuleFindings, type TurnEndingDeps, turnEndingHooks } from "./turn-ending.js";

const rule = (over: Partial<Rule> & Pick<Rule, "id" | "action">): Rule => ({
    label: over.id,
    moment: "turn.ending",
    enabled: true,
    ...over,
});

// A repository's turn check that fails under its own name: the simplest rule that speaks at every Stop it stands at.
const speaking = (id: string, when?: Rule["when"]): Rule =>
    rule({ id, ...(when === undefined ? {} : { when }), action: { kind: "command", command: `check-${id}`, timeoutMs: 900_000 } });
const SAYS_NO: TurnEndingDeps = { runCommand: async (command) => ({ status: "failed", exitCode: 1, output: `${command} said no` }) };

// Drives the hook set the way the SDK does: finds a hook by matcher/tool name, not position, so tests can interleave
// edits, commands and stops against one ledger.
const pick = (hooks: ReturnType<typeof turnEndingHooks>, event: "PostToolUse", toolName: string) => {
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

const stop = async (hooks: ReturnType<typeof turnEndingHooks>, stop_hook_active = false) => {
    const matcher = hooks.Stop![0]!;
    const input = { hook_event_name: "Stop", stop_hook_active } as unknown as HookInput;
    const result = await matcher.hooks[0]!(input, "t", { signal: new AbortController().signal });
    return (syncHookOutput(result).hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;
};

const armed = (rules: readonly Rule[], deps: TurnEndingDeps = {}) => turnEndingHooks(rules, deps);

const PASSED = "all good\n--- [exit 0, 2s] 40 lines filtered to 12\n";
const FAILED = "1 failed\n--- [exit 1, 2s] 40 lines filtered to 12\n";

describe("no rules", () => {
    test("wires no hooks at all", () => {
        expect(turnEndingHooks([])).toEqual({});
    });

    test("and a rule for another moment says nothing at a stop", async () => {
        const elsewhere = rule({ id: "x", moment: "agent.finished", action: { kind: "verdict", verdict: "hold" } });
        expect(await stop(armed([elsewhere], SAYS_NO))).toBeUndefined();
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

    test("stands beside a red check in a single follow-up", async () => {
        const hooks = armed([speaking("suite"), VIEWING], SAYS_NO);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.vue`);
        const asked = await stop(hooks);
        expect(asked).toContain("App.vue");
        expect(asked).toContain("check-suite said no");
    });

    test("honours a path condition", async () => {
        const scoped = { ...VIEWING, when: { paths: ["src/legacy/**"] } };
        const hooks = armed([scoped]);
        await edit(hooks, `${WORKSPACE_ROOT}/src/App.vue`);
        expect(await stop(hooks)).toBeUndefined();
    });
});

describe("the follow-up budget", () => {
    test("at most two asks per turn: the third stop is silent", async () => {
        const hooks = armed([speaking("suite")], SAYS_NO);
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

    test("the final Stop refreshes a repaired command verdict without spending a third ask", async () => {
        const verdicts: string[] = [];
        let attempt = 0;
        const check = rule({ id: "check", action: { kind: "command", command: "pnpm verify", timeoutMs: 900_000 } });
        const hooks = armed([check], {
            runCommand: async () => {
                attempt += 1;
                return attempt < 3 ? { status: "failed", exitCode: 1, output: "1 failed" } : { status: "passed", exitCode: 0, output: "ok" };
            },
            onCheckRun: (fired, run) => verdicts.push(`${fired.id}:${run.status}`),
        });
        expect(await stop(hooks)).toContain("exited 1");
        expect(await stop(hooks, true)).toContain("exited 1");
        expect(await stop(hooks, true)).toBeUndefined();
        expect(verdicts).toEqual(["check:failed", "check:failed", "check:passed"]);
    });

    test("the final Stop preserves a command verdict that is still failing", async () => {
        const verdicts: string[] = [];
        const check = rule({ id: "check", action: { kind: "command", command: "pnpm verify", timeoutMs: 900_000 } });
        const hooks = armed([check], {
            runCommand: async () => ({ status: "failed", exitCode: 1, output: "1 failed" }),
            onCheckRun: (fired, run) => verdicts.push(`${fired.id}:${run.status}`),
        });
        expect(await stop(hooks)).toContain("exited 1");
        expect(await stop(hooks, true)).toContain("exited 1");
        expect(await stop(hooks, true)).toBeUndefined();
        expect(verdicts).toEqual(["check:failed", "check:failed", "check:failed"]);
    });

    test("several rules speaking at one stop spend one ask between them", async () => {
        const hooks = armed([speaking("suite"), speaking("changelog")], SAYS_NO);
        const first = await stop(hooks);
        expect(first).toContain("check-suite said no");
        expect(first).toContain("check-changelog said no");
        expect(await stop(hooks)).toEqual(expect.any(String));
        expect(await stop(hooks)).toBeUndefined();
    });
});

describe("conditions", () => {
    // Read at the Stop, not at planning time, since nothing yet knows which files a turn will touch when planned.
    test("a path condition is read against what the turn actually edited", async () => {
        const sql = speaking("sql", { paths: ["**/*.sql"] });
        const touched = armed([sql], { ...SAYS_NO, cwd: WORKSPACE_ROOT });
        await edit(touched, `${WORKSPACE_ROOT}/db/0001.sql`);
        expect(await stop(touched)).toContain("check-sql said no");

        const untouched = armed([sql], { ...SAYS_NO, cwd: "/work" });
        await edit(untouched, `${WORKSPACE_ROOT}/src/a.ts`);
        expect(await stop(untouched)).toBeUndefined();
    });

    // The edit ledger only hears Edit/Write; a shell rewrite (sed -i, a heredoc) is invisible to it, so the tree's own
    // diff is read too.
    test("a path condition also sees what the tree changed, however it was edited", async () => {
        const sql = speaking("sql", { paths: ["**/*.sql"] });
        const hooks = armed([sql], { ...SAYS_NO, cwd: WORKSPACE_ROOT, changedPaths: async () => ["db/0001.sql"] });
        // No Edit or Write reached the ledger: the migration was written by a shell command.
        expect(await stop(hooks)).toContain("check-sql said no");
    });

    test("paths are relativised to the turn's tree before a glob sees them", async () => {
        const docs = speaking("docs", { paths: ["docs/**"] });
        const hooks = armed([docs], { ...SAYS_NO, cwd: `${WORKSPACE_ROOT}/repo` });
        await edit(hooks, `${WORKSPACE_ROOT}/repo/docs/intro.md`);
        expect(await stop(hooks)).toContain("check-docs said no");
    });

    test("a rule with no condition still fires on a turn that edited nothing", async () => {
        expect(await stop(armed([speaking("always")], SAYS_NO))).toContain("check-always said no");
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
        const look = rule({ id: "look", action: { kind: "builtin", name: "verify-ui-edits" } });
        const hooks = armed([look, speaking("quiet", { paths: ["**/*.sql"] }), speaking("loud")], { ...SAYS_NO, onFired: (r) => fired.push(r.id) });
        // No edits: the look has nothing to ask for, and the sql check's condition cannot hold.
        await stop(hooks);
        expect(fired).toEqual(["loud"]);
    });
});

describe("the daemon's own run of the command rules", () => {
    const CHECK = rule({
        id: "check",
        label: "Verify before you finish",
        action: { kind: "command", command: "pnpm verify:turn", timeoutMs: 900_000 },
    });

    test("a failing command is one finding worded for the model, told to onCheckRun and onFired", async () => {
        const runs: string[] = [];
        const checked: string[] = [];
        const fired: string[] = [];
        const findings = await commandRuleFindings(
            [CHECK],
            { paths: ["src/a.ts"] },
            {
                runCommand: async (command) => {
                    runs.push(command);
                    return { status: "failed", exitCode: 1, output: FAILED };
                },
                onCheckRun: (checkRule, run) => checked.push(`${checkRule.id}:${run.status}`),
                onFired: (checkRule) => fired.push(checkRule.id),
            },
        );
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
    const CHECK = rule({
        id: "check",
        label: "Verify before you finish",
        action: { kind: "command", command: "pnpm verify:turn", timeoutMs: 900_000 },
    });

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

describe("the rebase a Stop makes before its checks", () => {
    const CHECK = rule({ id: "turn-check", action: { kind: "command", command: "pnpm verify:turn", timeoutMs: 900_000 } });

    test("runs before any check reads the tree, and a follow-up says the tree moved under the model", async () => {
        const order: string[] = [];
        const hooks = armed([CHECK], {
            syncBeforeChecks: async () => {
                order.push("sync");
                return 3;
            },
            runCommand: async () => {
                order.push("check");
                return { status: "failed", exitCode: 1, output: "1 failed" };
            },
        });
        const said = await stop(hooks);
        expect(order).toEqual(["sync", "check"]);
        expect(said?.startsWith("Main moved on while this turn ran: 3 commit(s)")).toBe(true);
        expect(said).toContain("1 failed");
    });

    test("a Stop with nothing to say stays silent however far the tree moved", async () => {
        const hooks = armed([CHECK], { syncBeforeChecks: async () => 5, runCommand: async () => ({ status: "passed", exitCode: 0, output: "ok" }) });
        expect(await stop(hooks)).toBeUndefined();
    });

    test("a rebase that fails is a tree that did not move, never a Stop that cannot end", async () => {
        const hooks = armed([CHECK], {
            syncBeforeChecks: async () => {
                throw new Error("rebase refused");
            },
            runCommand: async () => ({ status: "failed", exitCode: 1, output: "1 failed" }),
        });
        const said = await stop(hooks);
        expect(said).not.toContain("Main moved on");
        expect(said).toContain("1 failed");
    });
});
