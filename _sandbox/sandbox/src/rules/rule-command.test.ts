import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { Logger } from "pino";
import { test, expect } from "bun:test";
import { checkRunningIn } from "../workspace/deps/checks-in-flight.js";
import { type RuleCommandDeps, runRuleCommand } from "./rule-command.js";

// A rule's command is the daemon running a build on a tree. On the main tree that is the tree the review reads, so the
// window it opens is what keeps a build's emptied output dirs out of the owner's Changes list.

const ROOT = WORKSPACE_ROOT;

const deps = (tryRun: () => Promise<{ code: number; output: string }>): RuleCommandDeps =>
    ({
        logger: { warn: () => undefined, info: () => undefined } as unknown as Logger,
        terminalRun: { tryRun },
        workspace: { root: ROOT },
    }) as unknown as RuleCommandDeps;

const request = (cwd: string): Parameters<typeof runRuleCommand>[1] => ({
    command: "pnpm run verify",
    timeoutMs: 10_000,
    cwd,
    session: "checks",
    window: "checks",
    outputBytes: 500,
});

test("a check on the main tree holds its repo's window open while it runs and closes it on the way out", async () => {
    const during: boolean[] = [];
    const run = await runRuleCommand(
        deps(async () => {
            during.push(checkRunningIn("app"));
            return { code: 0, output: "" };
        }),
        request(`${ROOT}/app`),
    );
    expect(run.status).toBe("passed");
    expect(during).toEqual([true]);
    expect(checkRunningIn("app")).toBe(false);
});

test("a command that never ran closes the window too: a failure must not hide the repo's build outputs for good", async () => {
    const run = await runRuleCommand(
        deps(() => Promise.reject(new Error("no terminal"))),
        request(`${ROOT}/app`),
    );
    expect(run.status).toBe("error");
    expect(checkRunningIn("app")).toBe(false);
});

test("a command run outside the workspace opens no window: an isolated turn's worktree is reviewed against its branch", async () => {
    const during: boolean[] = [];
    await runRuleCommand(
        deps(async () => {
            during.push(checkRunningIn("app"));
            return { code: 0, output: "" };
        }),
        request(`${HISTORY_ROOT}/worktrees/glad-beacon/app`),
    );
    expect(during).toEqual([false]);
});
